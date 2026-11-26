import { OpsConfig, getConfig } from "./models.js";

/*
 * Keeps the 15-minute QStash schedule that runs the agent's tick. It is
 * created automatically the first time an admin opens the Ops tab (and
 * re-checked once a day by the daily Vercel Cron), so nobody has to press a
 * button. Creating it again is harmless: the fixed schedule id "ops-tick"
 * makes QStash update the existing schedule instead of adding a second one.
 */

const DAY = 86400000;

export const automationReady = () => !!(process.env.QSTASH_TOKEN && process.env.BASE_URL && process.env.INTERNAL_ROUTE_SECRET);

/** Creates/refreshes the schedule unless it was confirmed in the last day (or `force`). */
export const ensureAutomation = async ({ force = false } = {}) => {
  if (!automationReady()) return { on: false, reason: "QSTASH_TOKEN, BASE_URL and INTERNAL_ROUTE_SECRET must be set on the server" };
  const config = await getConfig();
  const last = config.lastRuns?.automation;
  if (!force && last?.ok && Date.now() - new Date(last.at).getTime() < DAY) return { on: true, scheduleId: last.scheduleId, cached: true };

  let entry;
  try {
    const res = await fetch(`https://qstash.upstash.io/v2/schedules/${process.env.BASE_URL}ops/tick`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
        "Upstash-Cron": "*/15 * * * *",
        "Upstash-Schedule-Id": "ops-tick",
        "Upstash-Forward-x-internal-secret": process.env.INTERNAL_ROUTE_SECRET,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    entry = res.ok
      ? { ok: true, at: new Date(), scheduleId: body.scheduleId ?? "ops-tick" }
      : { ok: false, at: new Date(), error: `QStash: ${body.error || res.status}` };
  } catch (err) {
    entry = { ok: false, at: new Date(), error: `QStash: ${err.message}` };
  }
  await OpsConfig.updateOne({ _id: "ops" }, { $set: { "lastRuns.automation": entry } });
  return entry.ok ? { on: true, scheduleId: entry.scheduleId } : { on: false, reason: entry.error };
};

/** For the Settings status line: is the tick actually running? */
export const automationStatus = (config) => {
  const tick = config.lastRuns?.tick;
  const auto = config.lastRuns?.automation;
  const minutes = tick ? Math.round((Date.now() - new Date(tick.at).getTime()) / 60000) : null;
  return {
    ready: automationReady(),
    scheduled: !!auto?.ok,
    error: auto && !auto.ok ? auto.error : null,
    lastTickMinutes: minutes,
    healthy: minutes != null && minutes <= 30,
  };
};
