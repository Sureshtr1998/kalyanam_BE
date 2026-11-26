import { OpsConfig, getConfig } from "./models.js";

/*
 * The agent's heartbeat: a Vercel Cron job every 15 minutes (vercel.json;
 * the Pro plan allows any schedule) that calls /api/ops/tick with the
 * CRON_SECRET. Nothing to start or keep alive.
 *
 * It used to be a QStash schedule ("ops-tick"). QStash's daily message
 * quota is shared with payment fulfilment, photo clean-up and verification,
 * and on 26 Nov 2026 the schedule stopped firing after 1:45 pm. So the agent
 * no longer uses QStash at all: the first tick that arrives from Vercel Cron
 * deletes the old schedule, leaving the quota to payments.
 */

const QSTASH = "https://qstash.upstash.io/v2/schedules/ops-tick";

export const automationReady = () => !!process.env.CRON_SECRET;

/** Where a tick request came from: Vercel Cron, the old QStash schedule, or someone else. */
export const tickSource = (req) => {
  if (/vercel-cron/i.test(req.header("user-agent") || "")) return "vercel";
  if (req.header("upstash-signature") || req.header("upstash-schedule-id") || req.header("upstash-message-id")) return "qstash";
  return "other";
};

/**
 * Once Vercel Cron is seen running, removes the old QStash schedule (once).
 * Cheap no-op otherwise. Never throws.
 * @param {{ source?: string }} [p]
 */
export const ensureAutomation = async ({ source } = {}) => {
  const config = await getConfig();
  const last = config.lastRuns?.automation;
  if (last?.mode === "vercel" || source !== "vercel") return { on: automationReady(), mode: last?.mode ?? "vercel-cron" };
  let qstash = "none";
  if (process.env.QSTASH_TOKEN) {
    try {
      const res = await fetch(QSTASH, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` },
        signal: AbortSignal.timeout(10000),
      });
      qstash = res.ok || res.status === 404 ? "removed" : `QStash answered ${res.status}`;
    } catch (err) {
      qstash = `QStash: ${err.message}`;
    }
  }
  const entry = { ok: true, mode: "vercel", at: new Date(), qstash };
  await OpsConfig.updateOne({ _id: "ops" }, { $set: { "lastRuns.automation": entry } });
  return { on: true, mode: "vercel", qstash };
};

/** For the Settings status line: is the tick actually running? */
export const automationStatus = (config) => {
  const tick = config.lastRuns?.tick;
  const minutes = tick ? Math.round((Date.now() - new Date(tick.at).getTime()) / 60000) : null;
  const ready = automationReady();
  return {
    ready,
    scheduled: ready,
    error: ready ? null : "CRON_SECRET must be set on the server (Vercel → Settings → Environment Variables) for Vercel Cron to call the agent",
    lastTickMinutes: minutes,
    source: tick?.source ?? null,
    healthy: minutes != null && minutes <= 30,
    stalled: minutes != null && minutes > 30,
  };
};
