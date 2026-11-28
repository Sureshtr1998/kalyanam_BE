import { OpsAction, OpsConfig, getConfig } from "./models.js";
import { cancelOrphanCreatives, closeBounceAlerts, mergeLegacyPairs, notice, resolveHandledRepeats, runDue, tidyStaleAlerts } from "./actions.js";
import { metaConfigured, pageConfigured, resolvePage, igConfigured } from "./meta.js";
import { mailConfigured } from "./mail.js";
import { claudeConfigured } from "./claude.js";
import { runAdsCycle } from "./ads.js";
import { refreshOpenRefunds, runSupportCycle } from "./support.js";
import { runReminders } from "./reminders.js";
import { runCommentsCycle } from "./comments.js";
import { planWeek, recordOrganicStats, recordStoryStats, requestRenders, settlePublished, sweepCancelled } from "./organic.js";
import { readTools } from "./tools.js";
import { runSeoWeekly, seoConfigured } from "./seo.js";
import { runWeeklyReview } from "./review.js";
import { proposeMergeTest, runAdsPlanning } from "./adsGrowth.js";
import { preflightLaunches, tagIdeaCreatives } from "./adsCreative.js";
import { autoPlanIdeas } from "./ideas.js";
import { ensureAutomation } from "./automation.js";
import { autoVerifyDue, getAutoVerifySettings } from "../utils/autoVerify.js";
import { runMembershipCycle } from "../utils/membership.js";

// Handlers register themselves on import.
import "./dev.js";

/*
 * One "tick" every 15 minutes (QStash schedule, with a daily Vercel Cron as
 * a fallback). Cheap work runs every tick; at most one heavy job runs per
 * tick so a tick stays well inside the function time limit.
 */

const HOUR = 3600000;
const ist = () => {
  const d = new Date(Date.now() + 5.5 * HOUR);
  return { day: d.getUTCDay(), hour: d.getUTCHours() + d.getUTCMinutes() / 60, date: d.toISOString().slice(0, 10) };
};

/** Jobs in priority order. `due` decides from the last run and the IST clock. */
const JOBS = [
  {
    // Membership end dates, reminders, pausing, 90-day inactivity hide, dormant clean-up.
    // First so the daily Vercel Cron fallback (09:30 IST) always runs it.
    name: "membership",
    ready: () => true,
    due: (last, t) => t.hour >= 9 && last?.date !== t.date,
    run: () => runMembershipCycle(),
  },
  {
    name: "adsWeekly",
    ready: (c) => c.modes.ads !== "off" && metaConfigured(),
    due: (last, t) => t.day === 1 && t.hour >= 9.5 && last?.date !== t.date,
    run: () => runAdsCycle({ weekly: true }),
  },
  {
    // Thursday: a second raise for winners (3+ days after Monday's step). No moves or cuts.
    name: "adsMidweek",
    ready: (c) => c.modes.ads !== "off" && metaConfigured(),
    due: (last, t) => t.day === 4 && t.hour >= 9.5 && last?.date !== t.date,
    run: () => runAdsCycle({ weekly: true, midweek: true }),
  },
  {
    name: "adsSnapshot",
    ready: (c) => c.modes.ads !== "off" && metaConfigured(),
    due: (last) => !last || Date.now() - new Date(last.at).getTime() > 3 * HOUR,
    run: () => runAdsCycle(),
  },
  {
    // Fresh creatives for tired ad sets and at most one new ad set, each with notice.
    name: "adsPlan",
    ready: (c) => c.modes.ads !== "off" && metaConfigured() && claudeConfigured(),
    due: (last, t) => t.day === 1 && t.hour >= 10 && last?.date !== t.date,
    run: () => runAdsPlanning(),
  },
  {
    name: "weeklyReview",
    ready: () => claudeConfigured(),
    due: (last, t) => t.day === 1 && t.hour >= 10.5 && last?.date !== t.date,
    run: () => runWeeklyReview(),
  },
  {
    name: "organicPlan",
    ready: (c) => c.modes.organic !== "off" && c.organic?.planEvenings && pageConfigured() && claudeConfigured(),
    due: (last, t) => t.day === 4 && t.hour >= 10 && last?.date !== t.date,
    run: () => planWeek(),
  },
  {
    // How organic posts did and the sign-ups traced to their links (read-only; for the Organic screen and /weekly-posts).
    name: "organicStats",
    ready: () => pageConfigured(),
    due: (last, t) => last?.date !== t.date && t.hour >= 7,
    run: () => recordOrganicStats(),
  },
  {
    // Instagram stories' numbers while they're live (the API shows a story for 24 h only).
    name: "storyStats",
    ready: () => igConfigured(),
    due: (last) => !last || Date.now() - new Date(last.at).getTime() > 3 * HOUR,
    run: () => recordStoryStats(),
  },
  {
    name: "seoWeekly",
    ready: (c) => c.modes.seo !== "off" && seoConfigured() && claudeConfigured(),
    due: (last, t) => t.day === 1 && t.hour >= 11 && last?.date !== t.date,
    run: () => runSeoWeekly(),
  },
  {
    // Ideas nobody scheduled or cancelled for 48 h get planned (one per hour).
    name: "ideasAuto",
    ready: () => claudeConfigured(),
    due: (last) => !last || Date.now() - new Date(last.at).getTime() > HOUR,
    run: () => autoPlanIdeas(),
  },
  {
    name: "tools",
    ready: (c) => c.modes.tools !== "off",
    due: (last, t) => last?.date !== t.date && t.hour >= 6,
    run: () => readTools(),
  },
];

const record = async (name, entry) =>
  OpsConfig.updateOne({ _id: "ops" }, { $set: { [`lastRuns.${name}`]: entry } });

/** What each job does, in the owner's words (for failure alerts). */
const JOB_LABEL = {
  actions: "Running due actions (replies, verifications, ad changes, posts)",
  support: "Reading the support inbox",
  comments: "Reading Facebook and Instagram comments",
  adsSnapshot: "Reading Meta ads",
  adsWeekly: "Monday ad budgets",
  adsMidweek: "Thursday raises for winning languages",
  adsPlan: "The ads batch (new and paused ads)",
  weeklyReview: "The weekly review",
  organicPlan: "Planning next week's posts",
  organicStats: "Reading post results",
  storyStats: "Reading story results",
  seoWeekly: "The Search Console read",
  ideasAuto: "Planning waiting ideas",
  tools: "Reading the tools' balances",
  reminders: "Sending reminders to unpaid sign-ups and unverified members",
};

/**
 * Failures in a row before the owner hears (WhatsApp + email). Weekly jobs don't
 * run again for a week, so one failure is enough; jobs that run every 15 minutes
 * get 3 tries (45 min) so a passing hiccup stays quiet.
 */
const ALERT_AFTER = { adsWeekly: 1, adsMidweek: 1, adsPlan: 1, weeklyReview: 1, organicPlan: 1, seoWeekly: 1, adsSnapshot: 2, organicStats: 2, tools: 2 };

/** Alerts once when a job keeps failing; marks the alert resolved when it works again. */
const watchFailures = async (name, prev, failed, error) => {
  if (!failed) {
    if (prev?.ok === false) {
      await OpsAction.updateMany(
        { type: "ops.job_failing", "payload.job": name, status: "info", "payload.resolvedAt": null },
        { $set: { "payload.resolvedAt": new Date() } }
      );
    }
    return {};
  }
  const fails = prev?.ok === false ? (prev.fails ?? 1) + 1 : 1;
  const failingSince = fails > 1 ? (prev.failingSince ?? prev.at) : new Date();
  if (fails === (ALERT_AFTER[name] ?? 3)) {
    const since = new Date(failingSince).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    await notice("tools", {
      type: "ops.job_failing",
      priority: "urgent",
      title: `${JOB_LABEL[name] ?? name} is failing`,
      reason: `It failed ${fails === 1 ? "on its run" : `${fails} times in a row`} (since ${since}): ${error}`,
      effect: "It runs again on its usual schedule, and this alert is marked resolved once it works. If it keeps failing, check Ops → Settings → Connections.",
      payload: { dedupeKey: `job_failing:${name}:${new Date(failingSince).toISOString()}`, job: name },
    });
  }
  return { fails, failingSince };
};

const attempt = async (name, fn) => {
  const t = ist();
  const started = Date.now();
  const prev = (await OpsConfig.findById("ops").select(`lastRuns.${name}`).lean().catch(() => null))?.lastRuns?.[name];
  try {
    const result = await fn();
    await record(name, { at: new Date(), date: t.date, ok: true, ms: Date.now() - started, result: result ?? null });
    await watchFailures(name, prev, false).catch(() => {});
    return { name, ok: true, result };
  } catch (err) {
    console.error(`[ops] ${name}:`, err.message);
    const error = String(err.message).slice(0, 300);
    const streak = await watchFailures(name, prev, true, error).catch(() => ({}));
    await record(name, { at: new Date(), date: t.date, ok: false, ms: Date.now() - started, error, ...streak });
    return { name, ok: false, error: err.message };
  }
};

/**
 * Runs one tick. `only` forces a single job by name (from the panel's "Run now").
 * `source`: "vercel" (Vercel Cron, every 15 minutes), "qstash" (the old schedule), "manual" or "other".
 * @param {{ only?: string, budgetMs?: number, source?: string }} [p]
 */
export const tick = async ({ only, budgetMs = 50000, source = "other" } = {}) => {
  const deadline = Date.now() + budgetMs;
  const config = await getConfig();
  const t = ist();
  const done = [];

  if (only) {
    const job = JOBS.find((j) => j.name === only);
    if (job) done.push(await attempt(job.name, job.run));
    else if (only === "support") done.push(await attempt("support", runSupportCycle));
    else if (only === "comments") done.push(await attempt("comments", runCommentsCycle));
    else if (only === "reminders") done.push(await attempt("reminders", runReminders));
    return done;
  }

  // One tick at a time: a second call while one runs just returns.
  const locked = await OpsConfig.findOneAndUpdate(
    { _id: "ops", $or: [{ tickLockUntil: null }, { tickLockUntil: { $lt: new Date() } }] },
    { $set: { tickLockUntil: new Date(deadline + 20000) } }
  );
  if (!locked) return [{ name: "tick", ok: true, result: "Another run is in progress" }];
  try {
    return await runTick({ config, t, done, deadline, source });
  } finally {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { tickLockUntil: null } }).catch(() => {});
  }
};

const runTick = async ({ config, t, done, deadline, source }) => {
  // The owner hears about gaps: runs should come every 15 minutes.
  const previous = config.lastRuns?.tick?.at;
  const gapMinutes = previous ? (Date.now() - new Date(previous).getTime()) / 60000 : 0;
  if (gapMinutes > 45) {
    await notice("tools", {
      type: "ops.missed_runs",
      priority: "urgent",
      title: `The Ops agent missed runs: the last one was ${Math.floor(gapMinutes / 60)} h ${Math.round(gapMinutes % 60)} min ago`,
      reason: "It should run every 15 minutes (Vercel Cron). Anything due in the gap (replies, verifications, ad changes) runs now.",
      effect: "If this repeats, check Vercel → the kalyanam-be project → Settings → Cron Jobs.",
      // One alert per gap (not per day), so a second gap on the same day is reported too.
      payload: { dedupeKey: `missed_runs:${new Date(previous).toISOString()}` },
    }).catch(() => {});
  } else {
    // Runs are back on time: earlier missed-runs alerts are marked resolved and leave Today.
    await OpsAction.updateMany(
      { type: "ops.missed_runs", status: "info", "payload.resolvedAt": null },
      { $set: { "payload.resolvedAt": new Date() } }
    ).catch(() => {});
  }

  // Find the Facebook Page / Instagram account from the token (cached for an hour).
  await resolvePage().catch(() => {});

  // Once: alerts that no longer apply leave Today.
  if (!config.migrations?.staleAlerts20261127) {
    await tidyStaleAlerts()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.staleAlerts20261127": new Date() } }))
      .catch((err) => console.error("[ops] stale alerts", err.message));
  }
  // Once: idea ads planned before they carried their idea (the 28 Nov pricing ads) take it from their link.
  if (!config.migrations?.ideaTags20261127) {
    await tagIdeaCreatives()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.ideaTags20261127": new Date() } }))
      .catch((err) => console.error("[ops] idea tags", err.message));
  }
  // Once: repeat-mail alerts the owner already acted on (before acting closed them) are resolved.
  if (!config.migrations?.repeatResolved20261127) {
    await resolveHandledRepeats()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.repeatResolved20261127": new Date() } }))
      .catch((err) => console.error("[ops] repeat alerts", err.message));
  }
  // Once: open refund cards from before one-card-per-member fold together and look their payment up in Razorpay.
  if (!config.migrations?.refundCards20261127) {
    await refreshOpenRefunds()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.refundCards20261127": new Date() } }))
      .catch((err) => console.error("[ops] refund cards", err.message));
  }
  // Once: the merged ad set test card (owner asked 28 Nov 2026); it waits for the owner's OK.
  if (!config.migrations?.mergeTestCard20261128 && config.modes.ads === "live" && metaConfigured()) {
    await proposeMergeTest()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.mergeTestCard20261128": new Date() } }))
      .catch((err) => console.error("[ops] merge test card", err.message));
  }
  // Once: delivery-failure alerts from before bounces were handled are closed.
  if (!config.migrations?.bounceAlerts20261128) {
    await closeBounceAlerts()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.bounceAlerts20261128": new Date() } }))
      .catch((err) => console.error("[ops] bounce alerts", err.message));
  }
  // Once: ads of new-ads cards cancelled earlier stop showing as scheduled.
  if (!config.migrations?.orphanCreatives20261128) {
    await cancelOrphanCreatives()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.orphanCreatives20261128": new Date() } }))
      .catch((err) => console.error("[ops] orphan creatives", err.message));
  }
  // Once: fold the old two-card pairs (hide + delete, Facebook + Instagram) into one card each.
  if (!config.migrations?.mergePairs20261127b) {
    await mergeLegacyPairs()
      .then(() => OpsConfig.updateOne({ _id: "ops" }, { $set: { "migrations.mergePairs20261127b": new Date() } }))
      .catch((err) => console.error("[ops] merge pairs", err.message));
  }

  // Vercel Cron is the timer now; the first tick from it removes the old QStash schedule.
  await ensureAutomation({ source }).catch(() => {});

  // In-app "OTP not received" help requests: verify the ones past their wait (only when the admin switch is on).
  await getAutoVerifySettings()
    .then((s) => (s.enabled ? autoVerifyDue() : 0))
    .catch((err) => console.error("[ops] auto-verify sweep", err.message));

  // Every tick: due actions first (replies and verifications waiting on their notice period).
  done.push(await attempt("actions", () => runDue(deadline - 15000)));

  if (config.modes.support !== "off" && mailConfigured() && claudeConfigured()) {
    done.push(await attempt("support", runSupportCycle));
  }
  // Reminders to unpaid sign-ups and unverified members (a few per run, 8 am – 9 pm IST).
  if (config.modes.support === "live" && Date.now() < deadline - 25000) {
    done.push(await attempt("reminders", runReminders));
  }
  if (config.modes.comments !== "off" && pageConfigured() && claudeConfigured() && Date.now() < deadline - 20000) {
    done.push(await attempt("comments", runCommentsCycle));
  }
  if (config.modes.organic !== "off") {
    await settlePublished().catch(() => {});
    // Cancelled posts that are still scheduled on Facebook come off there too.
    await sweepCancelled().catch((err) => console.error("[ops] unschedule", err.message));
    // Posts still waiting for their image get the render Action re-run (every 2 h, at most 3 times).
    await requestRenders().catch((err) => console.error("[ops] render retry", err.message));
  }

  // One heavy job per tick.
  const lastRuns = (await OpsConfig.findById("ops").lean())?.lastRuns ?? {};
  const job = JOBS.find((j) => j.ready(config) && j.due(lastRuns[j.name], t));
  if (job && Date.now() < deadline - 25000) done.push(await attempt(job.name, job.run));

  // New ads due within a day are checked with Meta ahead (no ad touched), so a refusal is known in time.
  if (config.modes.ads === "live" && metaConfigured() && Date.now() < deadline - 20000) {
    await preflightLaunches().catch((err) => console.error("[ops] launch check", err.message));
  }

  // Anything that became due while the jobs ran (e.g. comment replies) goes out now.
  if (Date.now() < deadline - 5000) await runDue(deadline);
  await record("tick", { at: new Date(), date: t.date, ok: done.every((d) => d.ok), source });
  return done;
};

export const JOB_NAMES = [...JOBS.map((j) => j.name), "support", "comments", "reminders"];
