import crypto from "crypto";
import { Router } from "express";
import { adminOnly, staffAuth } from "../../middleware/auth.js";
import { isInternalRequest } from "../../utils/payments.js";
import { MODES, MODULES, AdSnapshot, OpsAction, OpsComment, OpsCreative, OpsMail, OpsPost, OpsReport, getConfig, OpsStory, OpsConfig } from "../../ops/models.js";
import { cancel, dismissAlert, execute, retry, undo } from "../../ops/actions.js";
import { checkAndRecord, rehearseLaunch } from "../../ops/adsCreative.js";
import { tick, JOB_NAMES } from "../../ops/tick.js";
import { adsSettings, unitStates } from "../../ops/ads.js";
import { IDEAS, loadIdeaLibrary } from "../../ops/adsIdeas.js";
import { toolsOverview, updateTool } from "../../ops/tools.js";
import { growth } from "../../ops/review.js";
import { deletePostImage, organicSignups, renderDone, renderQueue, replanWeek, storyConcepts, unscheduleFacebook } from "../../ops/organic.js";
import { planIdea, addStandingIdea, removeStandingIdea } from "../../ops/ideas.js";
import { hinduCalendar } from "../../ops/hinduCalendar.js";
import { langPath } from "../../ops/links.js";
import { formatDraft } from "../../ops/support.js";
import { reminderStats, stopReminders } from "../../ops/reminders.js";
import razorpay from "../../config/razorpay.js";
import { ALERT_TEMPLATE, ALERT_TEMPLATE_BODY, normalizeWhatsapp, sendWhatsappAlert, whatsappConfigured } from "../../ops/whatsapp.js";
import { automationStatus, ensureAutomation, tickSource } from "../../ops/automation.js";
import { verifyRenderToken } from "../../ops/renderToken.js";
import { fetchScheduledPosts, resolvePage } from "../../ops/meta.js";
import { createRequest, deploy, devConfigured, followUp, listRequests } from "../../ops/dev.js";
import { claudeConfigured, inrRate, spendSummary } from "../../ops/claude.js";
import { igConfigured, metaConfigured, metaErrorText, pageConfigured, fetchAccount } from "../../ops/meta.js";
import { mailConfigured, testMailLogin } from "../../ops/mail.js";
import { seoConfigured } from "../../ops/seo.js";

/*
 * The admin "Ops" tab API (all under /manage/ops, admin only) and the tick
 * endpoint that QStash / Vercel Cron call every 15 minutes.
 */

const router = Router();

/* ------------------------------- the tick ------------------------------- */

const cronAuthorized = (req) => {
  if (isInternalRequest(req)) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(String(req.header("authorization") || ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

const runTick = async (req, res) => {
  if (!cronAuthorized(req)) return res.status(401).json({ msg: "Unauthorized" });
  try {
    return res.json({ ok: true, ran: await tick({ source: tickSource(req) }) });
  } catch (err) {
    console.error("[ops] tick", err);
    return res.status(500).json({ msg: "Tick failed" });
  }
};
router.get("/ops/tick", runTick);
router.post("/ops/tick", runTick);

/* The "Ops render" GitHub Action fetches posts to draw and sends the images back. */
const renderAuthorized = (req) => isInternalRequest(req) || verifyRenderToken(req.header("x-render-token"));

router.get("/ops/render-queue", async (req, res) => {
  if (!renderAuthorized(req)) return res.status(401).json({ msg: "Unauthorized" });
  return res.json({ posts: await renderQueue() });
});
router.post("/ops/render-done", async (req, res) => {
  if (!renderAuthorized(req)) return res.status(401).json({ msg: "Unauthorized" });
  const { postId, jpeg } = req.body || {};
  if (!postId || typeof jpeg !== "string" || jpeg.length < 1000) return res.status(400).json({ msg: "postId and jpeg are required" });
  try {
    return res.json(await renderDone(postId, jpeg));
  } catch (err) {
    return res.status(err.status || 500).json({ msg: err.message });
  }
});

/** The "don't remind me" link in reminder emails (signed per person). */
router.get("/reminders/stop", async (req, res) => {
  const ok = await stopReminders(String(req.query.k || ""), String(req.query.id || ""), String(req.query.s || "")).catch(() => false);
  res.status(ok ? 200 : 400).type("html").send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seetha Rama Kalyana</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${ok ? "Done. You won't get more reminders." : "This link isn't valid."}</h2><p><a href="https://www.seetharamakalyana.in">seetharamakalyana.in</a></p></body>`
  );
});

/* ------------------------------ admin API ------------------------------- */

router.use("/manage/ops", staffAuth, adminOnly);

const by = (req) => req.user?.basic?.uniqueId || req.user?.basic?.email || "admin";
/** Ops → Settings → WhatsApp alerts. */
const alertSettings = (config) => ({
  whatsapp: config.alerts?.whatsapp ?? "",
  lastSentAt: config.alerts?.lastSentAt ?? null,
  lastError: config.alerts?.lastError ?? "",
  lastErrorAt: config.alerts?.lastErrorAt ?? null,
  ready: whatsappConfigured(),
  template: ALERT_TEMPLATE.name,
  templateLanguage: ALERT_TEMPLATE.language,
  templateBody: ALERT_TEMPLATE_BODY,
});

const wrap = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    console.error("[ops api]", err.message);
    return res.status(err.status || 400).json({ msg: err.meta ? metaErrorText(err) : err.message || "Something went wrong" });
  }
};

const connections = () => ({
  claude: claudeConfigured(),
  meta: metaConfigured(),
  page: pageConfigured(),
  instagram: igConfigured(),
  mail: mailConfigured(),
  seo: seoConfigured(),
  github: devConfigured(),
  qstash: !!process.env.QSTASH_TOKEN && !!process.env.BASE_URL,
});

router.get(
  "/manage/ops/overview",
  wrap(async (_req, res) => {
    await resolvePage().catch(() => {});
    const config = await getConfig();
    const [counts, feed, spend, account, weekly, rate] = await Promise.all([
      OpsAction.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      OpsAction.find({ status: { $in: ["needs_you", "scheduled", "info", "shadow", "idea", "failed", "done"] } })
        .sort({ priority: -1, updatedAt: -1 })
        .limit(60)
        .lean(),
      spendSummary(),
      AdSnapshot.find({ level: "account" }).sort({ date: -1 }).limit(15).lean(),
      OpsReport.findOne({ kind: "weekly" }).sort({ createdAt: -1 }).lean(),
      inrRate(),
    ]);
    return res.json({
      modes: config.modes,
      limits: config.limits,
      ads: adsSettings(config),
      alerts: alertSettings(config),
      reminders: await reminderStats().catch(() => null),
      organic: { planEvenings: !!config.organic?.planEvenings, ownerUntil: config.organic?.ownerUntil ?? null },
      targets: config.targets,
      brief: config.brief,
      lastRuns: config.lastRuns,
      connections: connections(),
      automation: automationStatus(config),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
      feed,
      claude: { ...spend, budgetUsd: config.limits.claudeMonthlyUsd, inrRate: rate },
      accountDays: account.reverse(),
      weekly,
      jobs: JOB_NAMES,
    });
  })
);

router.get(
  "/manage/ops/actions",
  wrap(async (req, res) => {
    const q = {};
    if (req.query.status) q.status = { $in: String(req.query.status).split(",") };
    if (req.query.module) q.module = String(req.query.module);
    const items = await OpsAction.find(q).sort({ updatedAt: -1 }).limit(Math.min(200, Number(req.query.limit) || 50)).lean();
    return res.json({ items });
  })
);

router.post(
  "/manage/ops/actions/:id/run",
  wrap(async (req, res) => {
    const a = await execute(req.params.id, by(req));
    if (!a) return res.status(409).json({ msg: "This action has already run or was cancelled" });
    return res.json({ action: a, msg: a.status === "done" ? "Done" : a.error || "Failed" });
  })
);

/**
 * The owner's Refund button for a payment the card found in Razorpay (the
 * person has no account, or the payment isn't on it). Only a payment listed
 * on this open refund card; checked with Razorpay again right before. The
 * card's reply is sent afterwards by the button (run), as for other refunds.
 */
router.post(
  "/manage/ops/actions/:id/refund",
  wrap(async (req, res) => {
    const a = await OpsAction.findById(req.params.id);
    if (!a || a.type !== "support.refund" || a.status !== "needs_you") return res.status(409).json({ msg: "This refund card is no longer open" });
    const paymentId = String(req.body?.paymentId || "");
    const list = a.payload?.payments ?? [];
    const i = list.findIndex((p) => p.paymentId === paymentId && p.source === "razorpay");
    if (i < 0) return res.status(404).json({ msg: "That payment isn't on this card" });
    if (list[i].refunded || list[i].refundId) return res.status(400).json({ msg: "This payment has already been refunded" });
    const live = await razorpay.payments.fetch(paymentId);
    if (live?.status === "refunded" || (Number(live?.amount_refunded) || 0) >= (Number(live?.amount) || 0)) {
      list[i] = { ...list[i], refunded: true };
      a.payload = { ...a.payload, payments: list };
      a.markModified("payload");
      await a.save();
      return res.status(400).json({ msg: "Razorpay shows this payment already refunded" });
    }
    let refund;
    try {
      refund = await razorpay.payments.refund(paymentId, {
        speed: "normal",
        // @ts-ignore
        notes: { reason: "Refunded by admin (refund request card)", admin: by(req), card: String(a._id) },
      });
    } catch (err) {
      return res.status(400).json({ msg: err?.error?.description || "Razorpay could not process this refund" });
    }
    list[i] = { ...list[i], refunded: true, refundId: refund.id, refundedAt: new Date(), refundedBy: by(req) };
    a.payload = { ...a.payload, payments: list };
    a.markModified("payload");
    await a.save();
    return res.json({ msg: `Refunded ₹${refund.amount != null ? refund.amount / 100 : list[i].amount} · ${refund.id}` });
  })
);

/** "Mark as done" on an alert: it leaves Today (kept in Activity). */
router.post(
  "/manage/ops/actions/:id/dismiss",
  wrap(async (req, res) => {
    const a = await dismissAlert(req.params.id, by(req));
    if (!a) return res.status(409).json({ msg: "This alert is already closed" });
    return res.json({ action: a, msg: "Closed" });
  })
);

/** "Retry" for a failed action: back in the queue and run now (or at runAt). */
router.post(
  "/manage/ops/actions/:id/retry",
  wrap(async (req, res) => {
    const runAt = req.body?.runAt ? new Date(req.body.runAt) : new Date();
    if (Number.isNaN(runAt.getTime())) return res.status(400).json({ msg: "runAt must be a date" });
    const a = await retry(req.params.id, by(req), runAt);
    if (!a) return res.status(409).json({ msg: "Only a failed action can be retried" });
    if (a.status === "failed") return res.status(400).json({ msg: a.error });
    if (runAt.getTime() > Date.now()) return res.json({ action: a, msg: "Scheduled again" });
    const done = await execute(a._id, by(req));
    // A retry that fails again is an error (red), with Meta's reason.
    if (!["done", "scheduled"].includes(done?.status)) return res.status(400).json({ action: done, msg: done?.error || "Failed" });
    return res.json({ action: done, msg: done.status === "done" ? "Done" : "Scheduled: waiting for a step" });
  })
);

/** Makes a launch card's Meta creatives now (no ad is touched), to see if the launch would work. */
router.post(
  "/manage/ops/actions/:id/check",
  wrap(async (req, res) => {
    const a = await OpsAction.findById(req.params.id).lean();
    if (!a || a.type !== "ads.creative_launch") return res.status(404).json({ msg: "Only new-ad launches can be checked" });
    const r = await checkAndRecord(a);
    if (r.pending) return res.json({ ...r, msg: "The ad images are still being designed; check again once they're ready" });
    return res.status(r.ok ? 200 : 400).json({ ...r, msg: r.ok ? `Ready: ${r.checked} creative(s) made in Meta, no ad changed yet` : r.error });
  })
);

/** Rehearses a launch card's Meta steps (copy paused, new creative on it, copy deleted); nothing goes live. */
router.post(
  "/manage/ops/actions/:id/rehearse",
  wrap(async (req, res) => {
    const a = await OpsAction.findById(req.params.id).lean();
    if (!a || a.type !== "ads.creative_launch") return res.status(404).json({ msg: "Only new-ad launches can be rehearsed" });
    const r = await rehearseLaunch(a);
    return res.status(r.ok ? 200 : 400).json({ ...r, msg: r.ok ? `Rehearsal passed: ${r.steps.join("; ")}` : `${r.error} (${r.steps.join("; ")})` });
  })
);

/** "Pause / undo" for done ad changes: pauses what the agent created, restores what it changed. */
router.post(
  "/manage/ops/actions/:id/undo",
  wrap(async (req, res) => {
    const a = await undo(req.params.id, by(req));
    if (!a) return res.status(409).json({ msg: "Only finished actions can be undone" });
    return res.json({ action: a, msg: "Undone: paused / restored in Meta" });
  })
);

router.post(
  "/manage/ops/actions/:id/cancel",
  wrap(async (req, res) => {
    const a = await cancel(req.params.id, by(req));
    if (!a) return res.status(409).json({ msg: "This action can no longer be cancelled" });
    // Cancelling a post's schedule also cancels the post.
    let note = "";
    if (a.ref?.kind === "post" || a.ref?.kind === "post-ig") {
      const post = await OpsPost.findByIdAndUpdate(a.ref.id, { status: "cancelled" }, { new: true });
      if (post) {
        await deletePostImage(post);
        // Also take it off Facebook if the agent had already scheduled it there.
        try {
          if (await unscheduleFacebook(post)) note = " and removed from Facebook";
        } catch (err) {
          note = `. Facebook didn't remove it yet (${err.message}); the agent retries every 15 minutes.`;
        }
      }
    }
    return res.json({ action: a, msg: `Cancelled${note}` });
  })
);

/** Edit a draft, change when it runs, or schedule an idea. */
router.post(
  "/manage/ops/actions/:id",
  wrap(async (req, res) => {
    const a = await OpsAction.findById(req.params.id);
    if (!a || !["scheduled", "needs_you", "idea", "shadow"].includes(a.status)) {
      return res.status(409).json({ msg: "This action can no longer be changed" });
    }
    const { draft, reply, runAt, schedule } = req.body || {};
    if (typeof draft === "string") a.payload = { ...a.payload, draft: draft.slice(0, 5000) };
    if (typeof reply === "string") a.payload = { ...a.payload, reply: reply.slice(0, 1000) };
    if (runAt) a.runAt = new Date(runAt);
    if (schedule && a.status === "idea") {
      a.status = "scheduled";
      a.runAt = runAt ? new Date(runAt) : a.runAt ?? new Date();
    }
    a.markModified("payload");
    a.decidedBy = by(req);
    await a.save();
    return res.json({ action: a, msg: "Saved" });
  })
);

/** "Format my mail": the owner's own words → a structured reply (returned, not saved). */
router.post(
  "/manage/ops/actions/:id/format",
  wrap(async (req, res) => {
    const a = await OpsAction.findById(req.params.id).lean();
    if (!a || !["scheduled", "needs_you", "idea", "shadow"].includes(a.status)) {
      return res.status(409).json({ msg: "This action can no longer be changed" });
    }
    if (typeof a.payload?.draft !== "string") return res.status(400).json({ msg: "Only mail replies can be formatted" });
    const draft = await formatDraft({ action: a, text: req.body?.text });
    return res.json({ draft });
  })
);

router.post(
  "/manage/ops/actions/:id/read",
  wrap(async (req, res) => {
    await OpsAction.updateOne({ _id: req.params.id }, { readAt: new Date() });
    return res.json({ ok: true });
  })
);

/** "Plan an idea": turns the owner's idea into scheduled steps. */
router.post(
  "/manage/ops/ideas",
  wrap(async (req, res) => {
    const r = await planIdea({ text: req.body?.text, by: by(req) });
    const ok = r.steps.filter((s) => s.status !== "needs_you").length;
    return res.json({ ...r, msg: `${ok} of ${r.steps.length} step(s) scheduled${ok < r.steps.length ? "; the rest need you (see Today)" : ""}` });
  })
);

/** Standing ideas: kept in the regular organic and/or ads mix (plus the built-in ones, for reference). */
router.get(
  "/manage/ops/ideas/standing",
  wrap(async (_req, res) => {
    const { IDEAS, loadOwnerIdeas } = await import("../../ops/adsIdeas.js");
    const owner = await loadOwnerIdeas();
    const builtIn = Object.entries(IDEAS).filter(([, v]) => !v.owner).map(([key, v]) => ({ key, label: v.label }));
    return res.json({ ideas: owner, builtIn });
  })
);

router.post(
  "/manage/ops/ideas/standing",
  wrap(async (req, res) => {
    const idea = await addStandingIdea({ text: req.body?.text, target: req.body?.target, by: by(req) });
    const where = { organic: "organic posts", ads: "Meta ads", both: "organic posts and Meta ads" }[idea.target];
    return res.json({ idea, msg: `Added "${idea.label}" to the regular ${where}` });
  })
);

router.delete(
  "/manage/ops/ideas/standing/:key",
  wrap(async (req, res) => {
    const ok = await removeStandingIdea(String(req.params.key));
    return res.status(ok ? 200 : 404).json({ msg: ok ? "Removed" : "Not found" });
  })
);

/**
 * The full activity log: every action the agent took, planned or proposed,
 * newest first, with filters and paging.
 *   ?module=ads&status=done,failed&q=refund&from=2026-11-01&to=2026-11-30&page=1&limit=30
 */
router.get(
  "/manage/ops/activity",
  wrap(async (req, res) => {
    const q = {};
    if (req.query.module && MODULES.includes(String(req.query.module))) q.module = String(req.query.module);
    if (req.query.status) q.status = { $in: String(req.query.status).split(",").slice(0, 9) };
    const range = {};
    if (req.query.from) range.$gte = new Date(`${req.query.from}T00:00:00+05:30`);
    if (req.query.to) range.$lte = new Date(`${req.query.to}T23:59:59+05:30`);
    if (Object.keys(range).length) q.updatedAt = range;
    const text = String(req.query.q || "").trim().slice(0, 80);
    if (text) {
      const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ title: re }, { reason: re }, { effect: re }, { "payload.to": re }, { decidedBy: re }];
    }
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 30));
    const page = Math.max(1, Number(req.query.page) || 1);
    const [items, total, byStatus] = await Promise.all([
      OpsAction.find(q).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      OpsAction.countDocuments(q),
      OpsAction.aggregate([{ $match: { ...q, status: { $exists: true } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    return res.json({ items, total, page, pages: Math.ceil(total / limit), byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])) });
  })
);

router.get(
  "/manage/ops/calendar",
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 35 * 86400000);
    const [actions, posts] = await Promise.all([
      OpsAction.find({ runAt: { $gte: from, $lte: to }, status: { $nin: ["info"] } }).sort({ runAt: 1 }).lean(),
      OpsPost.find({ publishAt: { $gte: from, $lte: to } }).sort({ publishAt: 1 }).lean(),
    ]);
    // Fixed weekly rhythm, so the calendar shows what's coming even before actions exist.
    const recurring = [];
    for (let t = new Date(from); t <= to; t = new Date(t.getTime() + 86400000)) {
      const ist = new Date(t.getTime() + 5.5 * 3600000);
      const day = ist.getUTCDay();
      const at = (h, m) => new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - 5.5 * 3600000);
      if (day === 1) {
        recurring.push({ at: at(9, 30), module: "ads", title: "Ads weekly decisions" });
        recurring.push({ at: at(10, 30), module: "tools", title: "Weekly business review" });
        recurring.push({ at: at(11, 0), module: "seo", title: "Search Console read" });
      }
      if (day === 4) recurring.push({ at: at(10, 0), module: "organic", title: "Next week's posts planned" });
    }
    // Festivals and wedding periods the agent plans around (computed; see ops/hinduCalendar.js).
    const istDate = (d) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    const festivals = hinduCalendar(istDate(from), istDate(to));
    return res.json({ actions, posts, recurring, festivals });
  })
);

router.get(
  "/manage/ops/ads",
  wrap(async (req, res) => {
    const days = Math.min(90, Number(req.query.days) || 30);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const latest = await AdSnapshot.findOne({ level: "account" }).sort({ date: -1 }).lean();
    const week = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const [account, campaigns, ads, placements, units, actions] = await Promise.all([
      AdSnapshot.find({ level: "account", date: { $gte: since } }).sort({ date: 1 }).lean(),
      latest ? AdSnapshot.find({ level: "campaign", date: latest.date }).lean() : [],
      AdSnapshot.aggregate([
        { $match: { level: "ad", date: { $gte: week } } },
        { $group: { _id: "$entityId", name: { $first: "$name" }, campaignName: { $first: "$campaignName" }, spend: { $sum: "$spend" }, paid: { $sum: "$paid" }, leads: { $sum: "$leads" }, clicks: { $sum: "$clicks" } } },
        { $match: { spend: { $gt: 300 } } },
      ]),
      AdSnapshot.aggregate([
        { $match: { level: "placement", date: { $gte: week } } },
        { $group: { _id: "$entityId", spend: { $sum: "$spend" }, paid: { $sum: "$paid" }, leads: { $sum: "$leads" } } },
      ]),
      unitStates().catch(() => []),
      OpsAction.find({ module: "ads" }).sort({ updatedAt: -1 }).limit(30).lean(),
    ]);
    const [creatives, config, ideas] = await Promise.all([
      // Every ad still to come, plus the latest live and old ones.
      Promise.all([
        OpsCreative.find({ status: { $in: ["design", "ready"] } }).sort({ createdAt: -1 }).limit(40).lean(),
        OpsCreative.find({ status: { $nin: ["design", "ready"] } }).sort({ updatedAt: -1 }).limit(24).lean(),
      ]).then(([upcoming, rest]) => [...upcoming, ...rest]),
      getConfig(),
      loadIdeaLibrary(60).catch(() => []),
    ]);
    // Scheduled launch cards: when each upcoming ad goes live.
    const launches = await OpsAction.find({ type: "ads.creative_launch", status: { $in: ["scheduled", "needs_you", "shadow"] } })
      .select("runAt payload.creativeIds")
      .lean();
    const launchAt = new Map();
    for (const l of launches) for (const id of l.payload?.creativeIds ?? []) launchAt.set(String(id), l.runAt ?? null);
    const cpp = (a) => (a.paid ? a.spend / a.paid : Infinity);
    const ranked = [...ads].sort((a, b) => cpp(a) - cpp(b));
    return res.json({
      configured: metaConfigured(),
      latestDate: latest?.date ?? null,
      account,
      campaigns,
      units,
      bestAds: ranked.slice(0, 8),
      worstAds: ranked.slice(-8).reverse(),
      placements,
      actions,
      settings: adsSettings(config),
      ideas: ideas.map(({ ads: names, ...r }) => ({ ...r, label: IDEAS[r.idea]?.label ?? "Other", ads: names.length })),
      creatives: creatives.map((c) => ({
        _id: c._id,
        // When its launch card runs (scheduled ads), or when it went live.
        launchAt: launchAt.get(String(c._id)) ?? null,
        liveAt: c.liveAt ?? null,
        campaignName: c.campaignName,
        adsetName: c.adsetName,
        language: c.language,
        status: c.status,
        imageUrl: c.imageUrl,
        design: c.design,
        primaryText: c.primaryText,
        title: c.title,
        translation: c.translation,
        utmContent: c.utmContent,
        // The page the ad links to, e.g. "/kn/pricing" (null: the copied ad's own link).
        linkPage: c.linkPath ? `${langPath(c.language)}${c.linkPath}` : null,
        idea: c.idea,
        ideaLabel: IDEAS[c.idea]?.label,
        role: c.role,
        angle: c.angle,
        review: c.review,
        verdict: c.verdict,
        results: c.results,
        createdAt: c.createdAt,
      })),
    });
  })
);

router.get(
  "/manage/ops/funds",
  wrap(async (_req, res) => res.json({ account: await fetchAccount() }))
);

router.get(
  "/manage/ops/support",
  wrap(async (_req, res) => {
    const [mails, actions] = await Promise.all([
      OpsMail.find().sort({ receivedAt: -1 }).limit(60).populate("matchedUser", "basic.fullName basic.email basic.mobile basic.uniqueId isVerified").lean(),
      OpsAction.find({ module: "support" }).sort({ updatedAt: -1 }).limit(60).lean(),
    ]);
    return res.json({ mails, actions });
  })
);

router.get(
  "/manage/ops/comments",
  wrap(async (_req, res) => {
    const [comments, actions] = await Promise.all([
      OpsComment.find().sort({ createdAt: -1 }).limit(80).lean(),
      OpsAction.find({ module: "comments" }).sort({ updatedAt: -1 }).limit(60).lean(),
    ]);
    return res.json({ comments, actions });
  })
);

router.get(
  "/manage/ops/organic",
  wrap(async (_req, res) => {
    const [posts, stats, signups, stories] = await Promise.all([
      OpsPost.find({ publishAt: { $gte: new Date(Date.now() - 21 * 86400000) } }).sort({ publishAt: 1 }).lean(),
      OpsReport.findOne({ kind: "organic" }).sort({ createdAt: -1 }).lean(),
      organicSignups(28),
      OpsStory.find({ $or: [{ at: { $gte: new Date(Date.now() - 35 * 86400000) } }, { plannedAt: { $gte: new Date(Date.now() - 35 * 86400000) } }] })
        .sort({ plannedAt: -1, at: -1 })
        .lean(),
    ]);
    // What's scheduled on the Page (by hand or by the agent), so doubles are visible.
    const scheduled = await fetchScheduledPosts().catch((err) => ({ error: err.message }));
    // Live sign-up counts per tracking code (the stored report is refreshed daily).
    return res.json({
      posts,
      scheduled,
      stats: stats ? { ...stats.data, period: stats.period } : null,
      signups: Object.fromEntries(signups),
      stories,
      storyConcepts: storyConcepts(stories),
      // Why reach/clicks may be missing (e.g. the Meta token lacks an insights permission).
      storyInsightsErrors: (await OpsConfig.findById("ops").select("lastRuns.storyStats").lean())?.lastRuns?.storyStats?.result?.insightsErrors ?? null,
    });
  })
);

/**
 * /weekly-posts registers the stories it scheduled (time, language, concept),
 * so their results can be compared per concept. Same time again = updated.
 */
router.post(
  "/manage/ops/organic/stories",
  wrap(async (req, res) => {
    const list = Array.isArray(req.body?.stories) ? req.body.stories.slice(0, 50) : [];
    let saved = 0;
    for (const s of list) {
      const at = new Date(s?.at);
      if (Number.isNaN(at.getTime())) continue;
      const fields = {
        plannedAt: at,
        language: String(s.language ?? "").slice(0, 20),
        concept: String(s.concept ?? "").slice(0, 60),
        note: String(s.note ?? "").slice(0, 200),
      };
      await OpsStory.updateOne({ plannedAt: at }, { $set: fields }, { upsert: true });
      saved += 1;
    }
    if (!saved) return res.status(400).json({ msg: "Send { stories: [{ at, language, concept }] }" });
    return res.json({ saved, msg: `Saved ${saved} planned stor${saved === 1 ? "y" : "ies"}` });
  })
);

/** Re-plans next week's organic posts that are still waiting for their image (e.g. after a planner upgrade or failed images). */
router.post(
  "/manage/ops/organic/replan",
  wrap(async (_req, res) => {
    const r = await replanWeek();
    return res.json({ ...r, msg: r.skipped ? r.skipped : `Re-planned: ${r.planned} post(s) (${r.cancelled} older one(s) replaced)` });
  })
);

router.get("/manage/ops/tools", wrap(async (_req, res) => res.json({ tools: await toolsOverview() })));
router.post(
  "/manage/ops/tools/:id",
  wrap(async (req, res) => {
    await updateTool(req.params.id, req.body || {});
    return res.json({ tools: await toolsOverview(), msg: "Saved" });
  })
);

router.get(
  "/manage/ops/seo",
  wrap(async (_req, res) => {
    const [report, ideas] = await Promise.all([
      OpsReport.findOne({ kind: "seo" }).sort({ createdAt: -1 }).lean(),
      OpsAction.find({ module: "seo" }).sort({ updatedAt: -1 }).limit(20).lean(),
    ]);
    return res.json({ configured: seoConfigured(), report, ideas });
  })
);

router.get("/manage/ops/growth", wrap(async (_req, res) => res.json(await growth())));

router.get(
  "/manage/ops/reports",
  wrap(async (_req, res) => res.json({ reports: await OpsReport.find({ kind: "weekly" }).sort({ createdAt: -1 }).limit(12).lean() }))
);

router.get(
  "/manage/ops/dev",
  wrap(async (_req, res) => res.json({ configured: devConfigured(), requests: devConfigured() ? await listRequests() : [] }))
);
router.post(
  "/manage/ops/dev",
  wrap(async (req, res) => {
    const r = await createRequest({ ...req.body, by: by(req) });
    return res.json({ ...r, msg: req.body?.mode === "read" ? "Question sent. The answer appears here in a few minutes." : "Request sent. A preview link appears here when the change is ready." });
  })
);
router.post(
  "/manage/ops/dev/:repo/:number/comment",
  wrap(async (req, res) => {
    await followUp(req.params.repo, Number(req.params.number), req.body?.text);
    return res.json({ msg: "Sent to the agent" });
  })
);
router.post(
  "/manage/ops/dev/:repo/:number/deploy",
  wrap(async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ msg: "Confirm the deploy first" });
    const r = await deploy(req.params.repo, Number(req.params.number));
    return res.json({ ...r, msg: "Merged into master. Vercel is deploying it now." });
  })
);

router.post(
  "/manage/ops/config",
  wrap(async (req, res) => {
    const config = await getConfig();
    const { modes, limits, targets, brief, ads, organic, alerts } = req.body || {};
    if (alerts && typeof alerts.whatsapp === "string") {
      const raw = alerts.whatsapp.trim();
      const number = raw ? normalizeWhatsapp(raw) : "";
      if (number === null) return res.status(400).json({ msg: "Enter a 10-digit Indian mobile number for WhatsApp alerts" });
      config.set("alerts.whatsapp", number);
    }
    if (organic && typeof organic.planEvenings === "boolean") config.set("organic.planEvenings", organic.planEvenings);
    if (organic && "ownerUntil" in organic) {
      const d = organic.ownerUntil ? new Date(organic.ownerUntil) : null;
      if (d && Number.isNaN(d.getTime())) return res.status(400).json({ msg: "ownerUntil must be a date" });
      config.set("organic.ownerUntil", d);
    }
    if (modes) {
      for (const [k, v] of Object.entries(modes)) {
        if (MODULES.includes(k) && MODES.includes(String(v))) config.modes[k] = v;
      }
    }
    if (limits) {
      for (const [k, v] of Object.entries(limits)) {
        if (k in config.limits.toObject() && Number.isFinite(Number(v)) && Number(v) >= 0) config.limits[k] = Number(v);
      }
    }
    if (Array.isArray(targets)) {
      config.targets = targets
        .filter((t) => /^\d{4}-\d{2}$/.test(t?.month))
        .map((t) => ({ month: t.month, members: Number(t.members) || 0, revenue: Number(t.revenue) || 0, spend: Number(t.spend) || 0 }));
    }
    if (typeof brief === "string") config.brief = brief.slice(0, 8000);
    if (ads && typeof ads === "object") {
      for (const k of ["rebalance", "pauseLosingAds", "newAdsets"]) if (typeof ads[k] === "boolean") config.set(`ads.${k}`, ads[k]);
      for (const k of ["batchEveryDays"]) {
        if (ads[k] != null && Number.isFinite(Number(ads[k])) && Number(ads[k]) >= 0) config.set(`ads.${k}`, Number(ads[k]));
      }
      if (typeof ads.alertEmail === "string") {
        const list = ads.alertEmail.split(",").map((e) => e.trim()).filter(Boolean);
        if (list.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) return res.status(400).json({ msg: "Alert email doesn't look right" });
        config.set("ads.alertEmail", list.join(","));
      }
      if (typeof ads.preferences === "string") config.set("ads.preferences", ads.preferences.slice(0, 4000));
      if ("handsOffUntil" in ads) {
        const d = ads.handsOffUntil ? new Date(ads.handsOffUntil) : null;
        if (d && Number.isNaN(d.getTime())) return res.status(400).json({ msg: "Hands-off date isn't a date" });
        config.set("ads.handsOffUntil", d);
      }
    }
    config.updatedBy = by(req);
    await config.save();
    return res.json({ msg: "Saved", modes: config.modes, limits: config.limits, targets: config.targets, brief: config.brief, ads: adsSettings(config), alerts: alertSettings(config), organic: { planEvenings: !!config.organic?.planEvenings, ownerUntil: config.organic?.ownerUntil ?? null } });
  })
);

/** Sends a test WhatsApp alert to the saved number (shows MSG91's answer if it refuses). */
router.post(
  "/manage/ops/alerts/test",
  wrap(async (_req, res) => {
    const config = await getConfig();
    const to = normalizeWhatsapp(config.alerts?.whatsapp);
    if (!to) return res.status(400).json({ msg: "Save your WhatsApp number first" });
    if (!whatsappConfigured()) return res.status(400).json({ msg: "MSG91 WhatsApp isn't set up on the server" });
    try {
      await sendWhatsappAlert({
        to,
        title: "Test alert",
        detail: "WhatsApp alerts are on. You'll get one here when something fails, a member writes 3 times for something only you can settle, or anything else urgent needs you.",
      });
    } catch (err) {
      const message = String(err?.response?.data?.message || err?.message || err).slice(0, 300);
      await OpsConfig.updateOne({ _id: "ops" }, { $set: { "alerts.lastError": message, "alerts.lastErrorAt": new Date() } });
      return res.status(400).json({ msg: message });
    }
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "alerts.lastSentAt": new Date(), "alerts.lastError": "" } });
    // MSG91 takes the request first and delivers after; a refused delivery shows only in its logs.
    return res.json({ msg: "Handed to MSG91. It should reach your WhatsApp within a minute; if not, see MSG91 → WhatsApp → Logs → Failed Logs." });
  })
);

router.post(
  "/manage/ops/run/:job",
  wrap(async (req, res) => {
    if (!JOB_NAMES.includes(req.params.job)) return res.status(404).json({ msg: "Unknown job" });
    const [r] = await tick({ only: req.params.job, budgetMs: 55000 });
    return res.json({ result: r, msg: r?.ok ? "Done" : r?.error || "Failed" });
  })
);

router.post(
  "/manage/ops/test/:what",
  wrap(async (req, res) => {
    if (req.params.what === "mail") return res.json({ msg: "Mailbox login works", inbox: await testMailLogin() });
    if (req.params.what === "meta") {
      const a = await fetchAccount();
      return res.json({ msg: `Connected to ${a.name}`, account: a });
    }
    return res.status(404).json({ msg: "Unknown test" });
  })
);

/** Runs the agent once now (the "Run now" button next to the automation status). Vercel Cron runs it every 15 minutes. */
router.post(
  "/manage/ops/automation/start",
  wrap(async (_req, res) => {
    const ran = await tick({ source: "manual", budgetMs: 50000 });
    const failed = ran.filter((r) => !r.ok);
    return res.json({ msg: failed.length ? `Ran, with ${failed.length} problem(s): ${failed.map((f) => f.name).join(", ")}` : "Ran the agent now. Vercel Cron runs it every 15 minutes.", ran });
  })
);

export default router;
