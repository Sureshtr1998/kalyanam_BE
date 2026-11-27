import { OpsAction, getConfig } from "./models.js";

/*
 * The action queue. Modules propose actions; this file decides whether they
 * run (live), are only logged (shadow) or are dropped (off), and runs them
 * when their notice period ends.
 */

const handlers = new Map();
const undoers = new Map();

/** Registers the function that carries out one action type. */
export const handle = (type, fn) => handlers.set(type, fn);

/** Registers how to reverse a done action (the "Pause / undo" button). */
export const handleUndo = (type, fn) => undoers.set(type, fn);
export const canUndo = (type) => undoers.has(type);

/** Thrown by a handler that isn't ready yet: the action is retried later instead of failing. */
export class Defer extends Error {
  constructor(message, ms = 2 * 3600000) {
    super(message);
    this.ms = ms;
  }
}

const OPEN = ["scheduled", "needs_you", "shadow", "idea", "running"];

/**
 * Adds an action unless an open one with the same dedupe key exists.
 * `status` defaults to "scheduled"; in shadow mode scheduled actions are
 * stored as "shadow" so nothing runs.
 */
export const propose = async (module, fields, { dedupeKey } = {}) => {
  const config = await getConfig();
  const mode = config.modes[module] ?? "off";
  if (mode === "off" && fields.status !== "info") return null;

  const key = dedupeKey ?? fields.payload?.dedupeKey ?? (fields.ref?.id ? `${fields.type}:${fields.ref.id}` : null);
  if (key) {
    // Open actions, and alerts from the last day, aren't repeated.
    const existing = await OpsAction.findOne({
      "payload.dedupeKey": key,
      $or: [{ status: { $in: OPEN } }, { status: "info", createdAt: { $gte: new Date(Date.now() - 86400000) } }],
    });
    if (existing) return existing;
  }
  let status = fields.status ?? "scheduled";
  if (mode === "shadow" && (status === "scheduled" || status === "needs_you")) status = "shadow";
  const doc = await OpsAction.create({
    ...fields,
    module,
    status,
    payload: { ...(fields.payload ?? {}), ...(key ? { dedupeKey: key } : {}), mode },
  });
  // Urgent alerts and urgent cards also go to the owner's email and WhatsApp (imported lazily: alerts.js reads models and mail).
  if (fields.priority === "urgent") {
    const { alertOwner } = await import("./alerts.js");
    await alertOwner(doc);
  }
  return doc;
};

/**
 * The owner acted on a member's mail card (approved, ran, cancelled): that
 * member's "mailed N times and needs you" alert is marked resolved.
 */
export const ownerActed = async (action, by) => {
  if (!action || !by || by === "agent" || action.module !== "support" || !action.payload?.to) return;
  await OpsAction.updateMany(
    { type: "support.repeat_mail", "payload.to": action.payload.to, status: "info", "payload.resolvedAt": null },
    { $set: { "payload.resolvedAt": new Date() } }
  ).catch(() => {});
};

/** Runs one action now. Safe to call twice: only one caller can claim it. */
export const execute = async (id, by = "agent") => {
  const action = await OpsAction.findOneAndUpdate(
    { _id: id, status: { $in: ["scheduled", "needs_you", "idea", "shadow"] } },
    { status: "running", decidedBy: by },
    { new: true }
  );
  if (!action) return null;
  const fn = handlers.get(action.type);
  if (!fn) {
    action.status = "failed";
    action.error = `No handler for ${action.type}`;
    return action.save();
  }
  try {
    const out = (await fn(action)) ?? { ok: true };
    if (out.next) return await continueWith(action, out);
    action.result = out;
    action.status = "done";
  } catch (err) {
    if (err instanceof Defer) {
      action.status = "scheduled";
      action.runAt = new Date(Date.now() + err.ms);
      action.error = err.message;
      action.payload = { ...action.payload, deferrals: (action.payload?.deferrals ?? 0) + 1 };
      action.markModified("payload");
      return action.save();
    }
    action.status = "failed";
    action.error = String(err?.message || err).slice(0, 500);
  }
  action.ranAt = new Date();
  const saved = await action.save();
  await ownerActed(saved, by);
  // A failed ad change, post, mail reply, verification or refund is something the owner must hear
  // about (urgent: email + WhatsApp, at most one WhatsApp per kind of failure in 12 h).
  if (saved.status === "failed" && ["ads", "organic", "support"].includes(saved.module)) {
    await notice(saved.module, {
      type: `${saved.module}.action_failed`,
      priority: "urgent",
      title: `Failed: ${saved.title}`.slice(0, 160),
      reason: saved.error,
      effect: "Nothing was changed by this step. Open the Ops tab to retry or cancel it.",
      payload: { dedupeKey: `failed:${saved._id}`, whatsappKey: `failed:${saved.type}` },
    }).catch(() => {});
  }
  return saved;
};

/**
 * A step that leads to another (hide a comment, then delete it; schedule on
 * Facebook, then post on Instagram) keeps one card: the same action is
 * re-scheduled with the next step instead of a second card being added.
 * The finished steps are kept in result.steps.
 */
const continueWith = async (action, { next, ...result }) => {
  const steps = [...(action.result?.steps ?? []), { type: action.type, title: action.title, at: new Date(), result }];
  const mode = (await getConfig()).modes[action.module] ?? "off";
  action.result = { steps };
  action.markModified("result");
  action.ranAt = new Date();
  if (mode === "off") {
    // Module switched off meanwhile: the step that ran stands, nothing more is scheduled.
    action.status = "done";
    return action.save();
  }
  action.type = next.type;
  if (next.title) action.title = next.title;
  if (next.reason) action.reason = next.reason;
  if (next.effect) action.effect = next.effect;
  action.payload = { ...action.payload, ...(next.payload ?? {}) };
  action.markModified("payload");
  action.runAt = next.runAt ?? new Date();
  action.error = undefined;
  action.status = mode === "shadow" ? "shadow" : "scheduled";
  return action.save();
};

/**
 * One-time tidy-up: before steps were kept on one card, a hidden comment
 * (or a post scheduled on Facebook) got a second card for its next step.
 * Each open follow-up card is folded into its first card, which carries on
 * with the next step; the extra card is removed. Returns how many merged.
 */
export const mergeLegacyPairs = async () => {
  const PAIRS = [
    ["comments.hide", "comments.delete"],
    ["organic.schedule", "organic.publish_ig"],
  ];
  let merged = 0;
  for (const [first, next] of PAIRS) {
    // Waiting follow-ups and finished ones (history) alike.
    const followUps = await OpsAction.find({ type: next, status: { $in: ["scheduled", "shadow", "needs_you", "done", "failed", "cancelled"] } });
    for (const f of followUps) {
      const refIds = [f.ref?.id, f.payload?.postId].filter(Boolean).map(String);
      const head = await OpsAction.findOne({
        type: first,
        status: "done",
        $or: [{ "ref.id": { $in: refIds } }, { "payload.postId": { $in: refIds } }],
      });
      if (!head) continue;
      head.result = { steps: [...(head.result?.steps ?? []), { type: head.type, title: head.title, at: head.ranAt ?? head.updatedAt, result: head.result ?? {} }] };
      head.markModified("result");
      head.type = f.type;
      if (first === "comments.hide") head.title = head.title.replace(/^Hide /, "Delete hidden ");
      head.effect = f.effect;
      head.runAt = f.runAt;
      head.status = f.status;
      if (f.ranAt) head.ranAt = f.ranAt;
      if (f.error) head.error = f.error;
      if (f.status === "done") head.result = { ...head.result, ...(f.result ?? {}) };
      head.payload = { ...head.payload, ...f.payload, dedupeKey: head.payload?.dedupeKey };
      head.markModified("payload");
      await head.save();
      await OpsAction.deleteOne({ _id: f._id });
      merged += 1;
    }
  }
  return merged;
};

/**
 * One-time tidy-up of alerts that no longer apply: funds alerts (funds are
 * never used now), "week planned" notes for weeks whose agent posts were all
 * cancelled, and the old separate "complained about paying" notices, which
 * move onto the comment's own card (marked urgent).
 */
export const tidyStaleAlerts = async () => {
  const now = new Date();
  const { OpsPost } = await import("./models.js");
  let tidied = (await OpsAction.updateMany({ type: "ads.funds_low", status: "info", "payload.resolvedAt": null }, { $set: { "payload.resolvedAt": now } })).modifiedCount;
  for (const n of await OpsAction.find({ type: "organic.week_planned", status: "info", "payload.resolvedAt": null })) {
    const monday = String(n.payload?.dedupeKey || "").replace(/^week:/, "");
    const from = new Date(`${monday}T00:00:00+05:30`);
    if (Number.isNaN(from.getTime())) continue;
    const live = await OpsPost.countDocuments({ publishAt: { $gte: from, $lt: new Date(from.getTime() + 7 * 86400000) }, status: { $nin: ["cancelled", "failed"] } });
    if (live) continue;
    n.payload = { ...n.payload, resolvedAt: now };
    n.markModified("payload");
    await n.save();
    tidied += 1;
  }
  for (const n of await OpsAction.find({ type: "comments.paid_complaint", status: "info" })) {
    const commentId = String(n.payload?.dedupeKey || "").replace(/^paid:/, "");
    const card = commentId && (await OpsAction.findOne({ module: "comments", "ref.id": commentId, type: { $in: ["comments.hide", "comments.delete"] } }));
    if (!card) continue;
    if (!/complained about paying/.test(card.title)) card.title = `${card.title}: complained about paying`.slice(0, 200);
    card.priority = "urgent";
    if (!/Check Members/.test(card.reason || "")) card.reason = `${card.reason || ""} Check Members for this name and reach out by email or WhatsApp if they are a paid member.`.trim();
    await card.save();
    await OpsAction.deleteOne({ _id: n._id });
    tidied += 1;
  }
  return tidied;
};

/** Reverses a done action (pauses what it created, restores what it changed). */
export const undo = async (id, by = "admin") => {
  const action = await OpsAction.findOne({ _id: id, status: "done" });
  if (!action) return null;
  const fn = undoers.get(action.type);
  if (!fn) throw new Error("This action can't be undone from here");
  await fn(action);
  action.status = "cancelled";
  action.decidedBy = by;
  action.result = { ...(action.result ?? {}), undoneAt: new Date(), undoneBy: by };
  return action.save();
};

/** Runs scheduled actions whose notice period is over, within a time budget. */
export const runDue = async (deadline) => {
  const due = await OpsAction.find({ status: "scheduled", runAt: { $lte: new Date() } }).sort({ runAt: 1 }).limit(20);
  const ran = [];
  for (const a of due) {
    if (Date.now() > deadline) break;
    ran.push(await execute(a._id));
  }
  return ran.filter(Boolean).length;
};

/**
 * Puts a failed action back in the queue (the "Retry" button). Its failure
 * alert is marked resolved. Returns the action, or null if it isn't failed.
 */
export const retry = async (id, by, runAt = new Date()) => {
  const a = await OpsAction.findOneAndUpdate(
    { _id: id, status: "failed" },
    { $set: { status: "scheduled", runAt, decidedBy: by }, $unset: { error: "", ranAt: "" } },
    { new: true }
  );
  if (!a) return null;
  if (!handlers.has(a.type)) {
    a.status = "failed";
    a.error = `No handler for ${a.type}`;
    return a.save();
  }
  await OpsAction.updateMany(
    { "payload.dedupeKey": `failed:${a._id}`, status: "info", "payload.resolvedAt": null },
    { $set: { "payload.resolvedAt": new Date() } }
  );
  return a;
};

export const cancel = async (id, by) => {
  const a = await OpsAction.findOneAndUpdate(
    { _id: id, status: { $in: ["scheduled", "needs_you", "idea", "shadow"] } },
    { status: "cancelled", decidedBy: by },
    { new: true }
  );
  await ownerActed(a, by);
  await cancelLaunchCreatives(a);
  return a;
};

/** A cancelled new-ads card takes its ads (not yet live) with it, so they don't look scheduled. */
const cancelLaunchCreatives = async (a) => {
  if (a?.type !== "ads.creative_launch" || !(a.payload?.creativeIds ?? []).length) return 0;
  const { OpsCreative } = await import("./models.js");
  const r = await OpsCreative.updateMany({ _id: { $in: a.payload.creativeIds }, status: { $in: ["design", "ready"] } }, { $set: { status: "cancelled" } });
  return r.modifiedCount ?? 0;
};

/** Once: ads of new-ads cards cancelled before that rule (still "ready") are marked cancelled. */
export const cancelOrphanCreatives = async () => {
  let n = 0;
  for (const a of await OpsAction.find({ type: "ads.creative_launch", status: "cancelled" }).select("type payload.creativeIds").lean()) {
    n += await cancelLaunchCreatives(a);
  }
  return n;
};

/**
 * Once: repeat-mail alerts the owner already acted on (a card of that member
 * decided by the owner after the alert) are marked resolved.
 */
export const resolveHandledRepeats = async () => {
  let resolved = 0;
  for (const alert of await OpsAction.find({ type: "support.repeat_mail", status: "info", "payload.resolvedAt": null })) {
    const acted = await OpsAction.exists({
      module: "support",
      "payload.to": alert.payload?.to,
      status: { $in: ["done", "cancelled"] },
      decidedBy: { $nin: [null, "agent"] },
      updatedAt: { $gt: alert.createdAt },
    });
    if (!acted) continue;
    alert.payload = { ...alert.payload, resolvedAt: new Date() };
    alert.markModified("payload");
    await alert.save();
    resolved += 1;
  }
  return resolved;
};

/** A one-line notice in the feed (alerts, summaries). Shown even in shadow mode. */
export const notice = (module, fields) => propose(module, { ...fields, status: "info" });

export const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);
