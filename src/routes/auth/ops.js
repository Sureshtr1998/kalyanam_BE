import crypto from "crypto";
import { Router } from "express";
import { adminOnly, staffAuth } from "../../middleware/auth.js";
import { isInternalRequest } from "../../utils/payments.js";
import { MODES, MODULES, AdSnapshot, OpsAction, OpsComment, OpsMail, OpsPost, OpsReport, getConfig } from "../../ops/models.js";
import { cancel, execute, undo } from "../../ops/actions.js";
import { tick, JOB_NAMES } from "../../ops/tick.js";
import { unitStates } from "../../ops/ads.js";
import { toolsOverview, updateTool } from "../../ops/tools.js";
import { growth } from "../../ops/review.js";
import { deletePostImage, renderDone, renderQueue } from "../../ops/organic.js";
import { planIdea } from "../../ops/ideas.js";
import { automationStatus, ensureAutomation } from "../../ops/automation.js";
import { verifyRenderToken } from "../../ops/renderToken.js";
import { resolvePage } from "../../ops/meta.js";
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
    return res.json({ ok: true, ran: await tick() });
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

/* ------------------------------ admin API ------------------------------- */

router.use("/manage/ops", staffAuth, adminOnly);

const by = (req) => req.user?.basic?.uniqueId || req.user?.basic?.email || "admin";
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
    // Opening the Ops tab is enough to switch the 15-minute schedule on (checked once a day).
    await ensureAutomation().catch(() => {});
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
    if (a.ref?.kind === "post" || a.ref?.kind === "post-ig") {
      const post = await OpsPost.findByIdAndUpdate(a.ref.id, { status: "cancelled" }, { new: true });
      if (post) await deletePostImage(post);
    }
    return res.json({ action: a, msg: "Cancelled" });
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
    return res.json({ actions, posts, recurring });
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
    const posts = await OpsPost.find({ publishAt: { $gte: new Date(Date.now() - 21 * 86400000) } }).sort({ publishAt: 1 }).lean();
    return res.json({ posts });
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
    const { modes, limits, targets, brief } = req.body || {};
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
    config.updatedBy = by(req);
    await config.save();
    return res.json({ msg: "Saved", modes: config.modes, limits: config.limits, targets: config.targets, brief: config.brief });
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

/** Re-creates the 15-minute schedule (normally automatic; this is the "Restart" button). */
router.post(
  "/manage/ops/automation/start",
  wrap(async (_req, res) => {
    const r = await ensureAutomation({ force: true });
    if (!r.on) return res.status(400).json({ msg: r.reason });
    return res.json({ msg: "Automation is on: the agent runs every 15 minutes", scheduleId: r.scheduleId });
  })
);

export default router;
