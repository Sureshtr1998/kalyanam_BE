import { OpsConfig, getConfig } from "./models.js";
import { runDue } from "./actions.js";
import { metaConfigured, pageConfigured, resolvePage } from "./meta.js";
import { mailConfigured } from "./mail.js";
import { claudeConfigured } from "./claude.js";
import { runAdsCycle } from "./ads.js";
import { runSupportCycle } from "./support.js";
import { runCommentsCycle } from "./comments.js";
import { planWeek, requestRenders, settlePublished } from "./organic.js";
import { readTools } from "./tools.js";
import { runSeoWeekly, seoConfigured } from "./seo.js";
import { runWeeklyReview } from "./review.js";
import { runAdsPlanning } from "./adsGrowth.js";
import { autoPlanIdeas } from "./ideas.js";
import { ensureAutomation } from "./automation.js";
import { autoVerifyDue, getAutoVerifySettings } from "../utils/autoVerify.js";

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
    name: "adsWeekly",
    ready: (c) => c.modes.ads !== "off" && metaConfigured(),
    due: (last, t) => t.day === 1 && t.hour >= 9.5 && last?.date !== t.date,
    run: () => runAdsCycle({ weekly: true }),
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
    ready: (c) => c.modes.organic !== "off" && pageConfigured() && claudeConfigured(),
    due: (last, t) => t.day === 4 && t.hour >= 10 && last?.date !== t.date,
    run: () => planWeek(),
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

const attempt = async (name, fn) => {
  const t = ist();
  const started = Date.now();
  try {
    const result = await fn();
    await record(name, { at: new Date(), date: t.date, ok: true, ms: Date.now() - started, result: result ?? null });
    return { name, ok: true, result };
  } catch (err) {
    console.error(`[ops] ${name}:`, err.message);
    await record(name, { at: new Date(), date: t.date, ok: false, ms: Date.now() - started, error: String(err.message).slice(0, 300) });
    return { name, ok: false, error: err.message };
  }
};

/** Runs one tick. `only` forces a single job by name (from the panel's "Run now"). */
export const tick = async ({ only, budgetMs = 50000 } = {}) => {
  const deadline = Date.now() + budgetMs;
  const config = await getConfig();
  const t = ist();
  const done = [];

  if (only) {
    const job = JOBS.find((j) => j.name === only);
    if (job) done.push(await attempt(job.name, job.run));
    else if (only === "support") done.push(await attempt("support", runSupportCycle));
    else if (only === "comments") done.push(await attempt("comments", runCommentsCycle));
    return done;
  }

  // Find the Facebook Page / Instagram account from the token (cached for an hour).
  await resolvePage().catch(() => {});

  // Make sure the 15-minute schedule exists (a no-op most of the time; recovers it if deleted).
  await ensureAutomation().catch(() => {});

  // In-app "OTP not received" help requests: verify the ones past their wait (only when the admin switch is on).
  await getAutoVerifySettings()
    .then((s) => (s.enabled ? autoVerifyDue() : 0))
    .catch((err) => console.error("[ops] auto-verify sweep", err.message));

  // Every tick: due actions first (replies and verifications waiting on their notice period).
  done.push(await attempt("actions", () => runDue(deadline - 15000)));

  if (config.modes.support !== "off" && mailConfigured() && claudeConfigured()) {
    done.push(await attempt("support", runSupportCycle));
  }
  if (config.modes.comments !== "off" && pageConfigured() && claudeConfigured() && Date.now() < deadline - 20000) {
    done.push(await attempt("comments", runCommentsCycle));
  }
  if (config.modes.organic !== "off") {
    await settlePublished().catch(() => {});
    // Posts still waiting for their image get the render Action re-run (every 2 h, at most 3 times).
    await requestRenders().catch((err) => console.error("[ops] render retry", err.message));
  }

  // One heavy job per tick.
  const lastRuns = (await OpsConfig.findById("ops").lean())?.lastRuns ?? {};
  const job = JOBS.find((j) => j.ready(config) && j.due(lastRuns[j.name], t));
  if (job && Date.now() < deadline - 25000) done.push(await attempt(job.name, job.run));

  // Anything that became due while the jobs ran (e.g. comment replies) goes out now.
  if (Date.now() < deadline - 5000) await runDue(deadline);
  await record("tick", { at: new Date(), date: t.date, ok: done.every((d) => d.ok) });
  return done;
};

export const JOB_NAMES = [...JOBS.map((j) => j.name), "support", "comments"];
