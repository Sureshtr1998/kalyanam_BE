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
  // Urgent alerts also go to the owner's email (imported lazily: alerts.js reads models and mail).
  if (status === "info" && fields.priority === "urgent") {
    const { alertOwner } = await import("./alerts.js");
    await alertOwner(doc);
  }
  return doc;
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
    action.result = (await fn(action)) ?? { ok: true };
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
  // A failed ad change or post is something the owner must hear about (emailed as urgent).
  if (saved.status === "failed" && (saved.module === "ads" || saved.module === "organic")) {
    await notice(saved.module, {
      type: `${saved.module}.action_failed`,
      priority: "urgent",
      title: `Failed: ${saved.title}`.slice(0, 160),
      reason: saved.error,
      effect: "Nothing was changed by this step. Open the Ops tab to retry or cancel it.",
      payload: { dedupeKey: `failed:${saved._id}` },
    }).catch(() => {});
  }
  return saved;
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

export const cancel = (id, by) =>
  OpsAction.findOneAndUpdate(
    { _id: id, status: { $in: ["scheduled", "needs_you", "idea", "shadow"] } },
    { status: "cancelled", decidedBy: by },
    { new: true }
  );

/** A one-line notice in the feed (alerts, summaries). Shown even in shadow mode. */
export const notice = (module, fields) => propose(module, { ...fields, status: "info" });

export const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);
