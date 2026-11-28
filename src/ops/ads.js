import User from "../models/User.js";
import Broker from "../models/Broker.js";
import { AdSnapshot, OpsAction, getConfig } from "./models.js";
import { RULES, adDecisions, applyTuning, brakes, calibration, decide, emergencies, languageCalibration, languageCoverage, languageOf, tagLanguage } from "./adsEngine.js";
import { IDEAS, judgeNewAds } from "./adsIdeas.js";
import { handle, handleUndo, hoursFromNow, notice, propose } from "./actions.js";
import {
  adIssuesFrom,
  dayIn,
  fetchAccount,
  fetchAds,
  fetchInsights,
  fetchStructure,
  graphAll,
  graphGet,
  accountId,
  setDailyBudget,
  setStatus,
} from "./meta.js";

/*
 * Meta ads for the ops agent:
 *  - every 3 hours: a snapshot of every campaign, ad set, ad and placement
 *    (kept forever), plus the alarms (account status, disapproved ads,
 *    stalled delivery, a language without ads), which are emailed to the owner.
 *    Prepaid funds are recorded for the panel but never drive a decision;
 *  - Monday: budget decisions from adsEngine.js (moves between languages,
 *    cuts, raises), each with the notice period;
 *  - batch days (adsGrowth.js): paused ads, fresh ads, new ad sets.
 */

const TZ_FALLBACK = "Asia/Kolkata";

/** The owner's ads settings as a plain object (Ops → Settings → Ads rules). */
export const adsSettings = (config) => config.toObject?.().ads ?? config.ads ?? {};
const DAY = 86400000;
const STRUCTURE_TYPES = ["ads.creative_launch", "ads.pause_ad", "ads.new_adset", "ads.merge_test"];
const BUDGET_TYPES = ["ads.budget", "ads.rebalance"];

const upsertRows = (level, rows, extra = {}) =>
  rows.length
    ? AdSnapshot.bulkWrite(
        rows.map((r) => ({
          updateOne: {
            filter: { level, entityId: r.entityId, date: r.date },
            update: { $set: { ...r, ...extra, level } },
            upsert: true,
          },
        }))
      )
    : null;

const dayExpr = (field, tz) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: tz } });

/** Real joins and net earnings per day from our own database. */
const joinsAndEarnings = async (since, tz) => {
  const sinceDate = new Date(`${since}T00:00:00Z`);
  const NET = {
    $subtract: [
      { $ifNull: ["$transactions.amountPaid", 0] },
      { $add: [{ $ifNull: ["$transactions.amountRefunded", 0] }, { $ifNull: ["$transactions.referralRefunded", 0] }] },
    ],
  };
  const earnPipe = [
    { $unwind: "$transactions" },
    { $match: { "transactions.dateOfTrans": { $gte: sinceDate } } },
    { $group: { _id: dayExpr("$transactions.dateOfTrans", tz), earned: { $sum: NET } } },
  ];
  const [joins, e1, e2] = await Promise.all([
    User.aggregate([{ $match: { createdAt: { $gte: sinceDate } } }, { $group: { _id: dayExpr("$createdAt", tz), n: { $sum: 1 } } }]),
    User.aggregate(earnPipe),
    Broker.aggregate(earnPipe),
  ]);
  const out = new Map();
  for (const j of joins) out.set(j._id, { joined: j.n, earned: 0 });
  for (const e of [...e1, ...e2]) {
    const row = out.get(e._id) ?? { joined: 0, earned: 0 };
    row.earned += e.earned;
    out.set(e._id, row);
  }
  return out;
};

/** Joins per day per mother tongue ("kannada" → { "2026-11-20": 12 }), the real result of each language campaign. */
const joinsByLanguage = async (since, tz) => {
  const rows = await User.aggregate([
    { $match: { createdAt: { $gte: new Date(`${since}T00:00:00Z`) } } },
    { $group: { _id: { d: dayExpr("$createdAt", tz), l: { $toLower: "$basic.motherTongue" } }, n: { $sum: 1 } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r._id.l)) out.set(r._id.l, new Map());
    out.get(r._id.l).set(r._id.d, r.n);
  }
  return out;
};

/**
 * Pulls the last `days` days from Meta into AdSnapshot. Re-pulling a day
 * overwrites it, because Meta keeps attributing joins for a few days.
 */
export const takeSnapshot = async (days = 14) => {
  const account = await fetchAccount();
  const tz = account.timezone || TZ_FALLBACK;
  const since = dayIn(tz, days - 1);
  const today = dayIn(tz);
  const yesterday = dayIn(tz, 1);

  const [structure, campaigns, adsets, ads, placements] = await Promise.all([
    fetchStructure(),
    fetchInsights("campaign", since, today),
    fetchInsights("adset", since, today),
    fetchInsights("ad", since, today),
    fetchInsights("account", dayIn(tz, 6), today, "publisher_platform"),
  ]);

  // 7-day frequency per ad set (frequency isn't additive across days).
  const freq = await graphAll(`${accountId()}/insights`, {
    level: "adset",
    fields: "adset_id,frequency",
    time_range: { since: dayIn(tz, 7), until: yesterday },
    limit: 500,
  });
  const freq7 = new Map(freq.map((f) => [f.adset_id, Number(f.frequency) || 0]));

  const budgetOf = new Map([...structure.campaigns, ...structure.adsets].map((e) => [e.id, e]));
  const withState = (rows) =>
    rows.map((r) => {
      const e = budgetOf.get(r.entityId);
      return r.date === today && e ? { ...r, dailyBudget: e.dailyBudget, status: e.status } : r;
    });

  await upsertRows("campaign", withState(campaigns));
  await upsertRows(
    "adset",
    withState(adsets).map((r) => (r.date === yesterday ? { ...r, frequency7: freq7.get(r.entityId) ?? 0 } : r))
  );
  await upsertRows("ad", ads);
  await upsertRows("placement", placements);

  // Account totals per day, with real joins and earnings and today's funds.
  const totals = new Map();
  for (const r of campaigns) {
    const t = totals.get(r.date) ?? { date: r.date, entityId: account.id, name: account.name, spend: 0, impressions: 0, clicks: 0, leads: 0, paid: 0 };
    t.spend += r.spend;
    t.impressions += r.impressions;
    t.clicks += r.clicks;
    t.leads += r.leads;
    t.paid += r.paid;
    totals.set(r.date, t);
  }
  const db = await joinsAndEarnings(since, tz);
  for (let i = 0; i < days; i++) {
    const d = dayIn(tz, i);
    const t = totals.get(d) ?? { date: d, entityId: account.id, name: account.name, spend: 0 };
    Object.assign(t, db.get(d) ?? { joined: 0, earned: 0 });
    if (d === today) t.funds = account.available ?? account.spendCapLeft ?? undefined;
    totals.set(d, t);
  }
  await upsertRows("account", [...totals.values()]);
  return { account, structure, today, yesterday, tz };
};

/** Real members per Meta-counted member over the last 14 completed days (see adsEngine.calibration). */
export const accountCalibration = async (yesterday) => {
  const rows = await AdSnapshot.find({ level: "account", date: { $lte: yesterday } }).sort({ date: -1 }).limit(14).lean();
  return calibration({
    metaPaid: rows.reduce((t, r) => t + (r.paid || 0), 0),
    realJoins: rows.reduce((t, r) => t + (r.joined || 0), 0),
  });
};

const maxDate = (dates) => {
  const t = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return t.length ? new Date(Math.max(...t)) : null;
};

/** When the agent last changed each entity: any change, budget change, ad or ad-set change. */
const lastChanges = async () => {
  const done = await OpsAction.find({ module: "ads", status: "done", ranAt: { $gte: new Date(Date.now() - 30 * DAY) } }).lean();
  const out = new Map();
  const mark = (id, kind, at) => {
    if (!id) return;
    const row = out.get(id) ?? {};
    row.any = maxDate([row.any, at]);
    row[kind] = maxDate([row[kind], at]);
    out.set(id, row);
  };
  for (const a of done) {
    const p = a.payload ?? {};
    if (BUDGET_TYPES.includes(a.type)) {
      for (const id of [p.entityId, ...(p.moves ?? []).map((m) => m.entityId)]) mark(id, "budget", a.ranAt);
      if (p.brake) mark(p.entityId, "brake", a.ranAt);
    } else if (STRUCTURE_TYPES.includes(a.type)) {
      for (const id of [p.campaignId, p.adsetId, a.result?.adsetId]) mark(id, "structure", a.ranAt);
      if (a.type === "ads.creative_launch") for (const id of [p.campaignId, p.adsetId]) mark(id, "launch", a.ranAt);
    }
  }
  return out;
};

/** When the last batch of ad / ad-set changes was planned (shadow ones count, so shadow mode keeps the real rhythm). */
export const lastBatchAt = async () => {
  const last = await OpsAction.findOne({ type: { $in: STRUCTURE_TYPES }, status: { $in: ["scheduled", "shadow", "running", "done"] } })
    .sort({ createdAt: -1 })
    .lean();
  return last?.createdAt ?? null;
};

/**
 * Members who signed up from an ad, per language, over the 14 days to
 * yesterday, from the tags on the ad's link (stored on each member since
 * 26 Nov 2026). null until tagged sign-ups cover the whole 14 days.
 */
export const taggedJoinsByLanguage = async (yesterday, tz = TZ_FALLBACK) => {
  const from = new Date(`${new Date(Date.parse(yesterday) - 13 * DAY).toISOString().slice(0, 10)}T00:00:00+05:30`);
  const to = new Date(`${yesterday}T23:59:59+05:30`);
  const first = await User.findOne({ "acquisition.utmSource": { $exists: true, $nin: [null, ""] } }).sort({ createdAt: 1 }).select("createdAt").lean();
  if (!first || first.createdAt > from) return null;
  const rows = await User.find({ createdAt: { $gte: from, $lte: to }, "acquisition.utmMedium": { $regex: /paid/i } })
    .select("acquisition.utmContent acquisition.utmCampaign")
    .lean();
  const out = {};
  for (const r of rows) {
    const lang = tagLanguage(r.acquisition ?? {});
    if (lang) out[lang] = (out[lang] ?? 0) + 1;
  }
  return out;
};

/** Builds the budget-owning units from stored snapshots (completed days only), with real joins per language. */
const buildUnits = async (structure, yesterday, tz = TZ_FALLBACK, settings = {}, accountCalib = 1) => {
  const since = new Date(Date.parse(yesterday) - 13 * DAY).toISOString().slice(0, 10);
  const rampLangs = new Set(settings.rampUp?.languages ?? []);
  const rampOn = !settings.rampUp?.until || new Date(settings.rampUp.until) > new Date();
  const active = (s) => s === "ACTIVE";
  const units = [];
  const changes = await lastChanges();
  const real = await joinsByLanguage(since, tz).catch(() => new Map());

  for (const c of structure.campaigns.filter((c) => active(c.status))) {
    const sets = structure.adsets.filter((s) => s.campaignId === c.id && active(s.status));
    const adsetBudgets = sets.some((s) => s.dailyBudget);
    const owners = adsetBudgets ? sets.filter((s) => s.dailyBudget) : [c];
    // Real joins only line up with a whole language campaign.
    const language = languageOf(c.name);
    const realDays = !adsetBudgets && language !== "English" ? real.get(language.toLowerCase()) ?? new Map() : null;
    for (const o of owners) {
      const level = adsetBudgets ? "adset" : "campaign";
      /** @type {any[]} */
      const rows = await AdSnapshot.find({ level, entityId: o.id, date: { $gte: since, $lte: yesterday } }).sort({ date: 1 }).lean();
      // Campaign units use the highest ad-set frequency as their fatigue signal.
      if (level === "campaign" && rows.length) {
        const f = await AdSnapshot.find({ level: "adset", campaignId: o.id, date: yesterday }).lean();
        rows.at(-1).frequency7 = Math.max(0, ...f.map((x) => x.frequency7 ?? 0));
      }
      if (realDays) for (const r of rows) r.real = realDays.get(r.date) ?? 0;
      const ids = [o.id, c.id, ...sets.map((s) => s.id)];
      // Meta stamps an ad set "edited" when ads are added to it. Stamps within 3 hours of the
      // agent's own ad changes aren't budget changes, so they don't put the language in learning.
      const structureAt = maxDate(ids.map((id) => changes.get(id)?.structure));
      const edited = (level === "adset" ? [o.updatedAt] : [c.updatedAt, ...sets.map((s) => s.updatedAt)]).filter(
        (d) => !(d && structureAt && Math.abs(new Date(d).getTime() - structureAt.getTime()) < 3 * 3600000)
      );
      units.push({
        id: o.id,
        campaignId: c.id,
        level,
        language,
        name: level === "adset" ? `${c.name} › ${o.name}` : c.name,
        dailyBudget: o.dailyBudget,
        days: rows,
        // Budget changes only (the agent's, or edits by hand in Ads Manager); new or paused ads don't count.
        lastChangeAt: maxDate([...edited, changes.get(o.id)?.budget]),
        lastBudgetChangeAt: changes.get(o.id)?.budget ?? null,
        lastStructureChangeAt: maxDate(ids.map((id) => changes.get(id)?.structure)),
        lastLaunchAt: maxDate(ids.map((id) => changes.get(id)?.launch)),
        lastBrakeAt: changes.get(o.id)?.brake ?? null,
        rampUp: rampOn && rampLangs.has(language),
      });
    }
  }
  // Each language's own real-joins correction, once ad-tagged sign-ups cover 14 days.
  const tagged = await taggedJoinsByLanguage(yesterday, tz).catch(() => null);
  if (tagged) {
    const metaPaid = {};
    for (const u of units.filter((x) => x.level === "campaign")) metaPaid[u.language] = (metaPaid[u.language] ?? 0) + u.days.reduce((t, r) => t + (r.paid || 0), 0);
    const perLang = languageCalibration({ metaPaid, tagged, accountCalib });
    if (perLang) {
      for (const u of units) {
        if (u.level !== "campaign" || perLang[u.language] == null) continue;
        u.calib = perLang[u.language];
        u.calibSource = "tagged";
        u.tagged14 = tagged[u.language] ?? 0;
      }
    }
  }
  return units;
};

/** Whether a campaign or ad set had a budget change in the last `days` days, or has one waiting. */
export const recentBudgetChange = async (entityId, days = 7) =>
  !!(await OpsAction.exists({
    type: { $in: BUDGET_TYPES },
    $and: [
      { $or: [{ "payload.entityId": entityId }, { "payload.moves.entityId": entityId }] },
      { $or: [{ status: { $in: ["scheduled", "shadow", "running"] } }, { status: "done", ranAt: { $gte: new Date(Date.now() - days * DAY) } }] },
    ],
  }));

/** ₹ of daily budget the agent added in the last 7 days (moves add nothing overall). */
const increasedThisWeek = async () => {
  const done = await OpsAction.find({ type: "ads.budget", status: "done", ranAt: { $gte: new Date(Date.now() - 7 * DAY) } }).lean();
  return done.reduce((t, a) => t + Math.max(0, (a.payload?.to ?? 0) - (a.payload?.from ?? 0)), 0);
};

/**
 * Every 3 hours: snapshot + alarms. Weekly (or when forced): budget
 * decisions, each with the configured notice period.
 */
/**
 * The mid-week brake on every 3-hour run: a −step for a language whose last 3
 * days cost twice its usual (ramp-up languages: an urgent alert instead).
 * At most one brake per language a week.
 */
const runBrakes = async (snap, settings, config) => {
  const calib = await accountCalibration(snap.yesterday);
  const units = await buildUnits(snap.structure, snap.yesterday, snap.tz, settings, calib);
  const { decisions, alerts } = brakes({ units, limits: config.limits, noticeHours: config.limits.adNoticeHours });
  const week = snap.today.slice(0, 8) + String(Math.ceil(Number(snap.today.slice(8)) / 7));
  let made = 0;
  for (const d of decisions) {
    const a = await propose(
      "ads",
      { type: d.type, title: d.title, reason: d.reason, effect: d.effect, payload: d.payload, ref: { kind: "meta", id: d.unitId }, runAt: hoursFromNow(config.limits.adNoticeHours) },
      { dedupeKey: `brake:${d.unitId}:${week}` }
    );
    if (a) made++;
  }
  for (const { unit, why } of alerts) {
    await notice("ads", {
      type: "ads.brake_alert",
      priority: "urgent",
      title: `${unit.name} cost twice its usual in the last 3 days`,
      reason: `${why} It's a ramp-up language, so the agent doesn't cut it; check for a disapproved ad, a broken link or a tracking problem.`,
      effect: "Alert only.",
      payload: { dedupeKey: `brake_alert:${unit.id}:${week}` },
    });
  }
  return { decisions: made, alerts: alerts.length };
};

/**
 * Every ad set should count sign-ups the same way (attribution setting);
 * mixed settings make languages and ads look better or worse than they are.
 * Flagged once a week; aligning it is done on a batch day, as it restarts learning.
 */
const checkAttribution = async (today) => {
  const r = await graphGet(`${accountId()}/adsets`, { fields: "name,effective_status,attribution_spec", limit: 100 });
  const live = (r.data ?? []).filter((s) => s.effective_status === "ACTIVE");
  const label = (spec = []) =>
    spec.map((x) => `${x.window_days}-day ${String(x.event_type).toLowerCase().replace("click_through", "click").replace("view_through", "view").replace("engaged_video_view", "engagement")}`).sort().join(", ") || "Meta's default";
  const groups = new Map();
  for (const s of live) groups.set(label(s.attribution_spec), [...(groups.get(label(s.attribution_spec)) ?? []), s.name]);
  if (groups.size <= 1) return 0;
  await notice("ads", {
    type: "ads.attribution_mixed",
    priority: "low",
    title: `Ad sets count sign-ups in ${groups.size} different ways`,
    reason: [...groups].map(([k, names]) => `${k}: ${names.join("; ")}`).join(" · ").slice(0, 900),
    effect: "Nothing to do. It only changes Meta's own counts; budget decisions use real sign-ups per language from the ads' link tags (from ~10 Dec). Changing it would restart learning, so it's left alone.",
    payload: { dedupeKey: `attribution:${today.slice(0, 7)}` },
  });
  return groups.size;
};

export const runAdsCycle = async ({ weekly = false, midweek = false } = {}) => {
  const config = await getConfig();
  applyTuning(config.algorithm?.tuning);
  const settings = adsSettings(config);
  const snap = await takeSnapshot();
  const activeCampaigns = snap.structure.campaigns.filter((c) => c.status === "ACTIVE");
  const activeIds = new Set(activeCampaigns.map((c) => c.id));
  const budgetTotal = [...activeCampaigns, ...snap.structure.adsets.filter((s) => activeIds.has(s.campaignId))]
    .filter((e) => e.status === "ACTIVE" && e.dailyBudget)
    .reduce((t, e) => t + e.dailyBudget, 0);
  const [todayRow, recent] = await Promise.all([
    AdSnapshot.findOne({ level: "account", date: snap.today }).lean(),
    AdSnapshot.find({ level: "account", date: { $lte: snap.yesterday } }).sort({ date: -1 }).limit(4).lean(),
  ]);
  const ads = await fetchAds().catch(() => []);
  // Spend "stalled" only when yesterday is also far below the days before (not just a new budget).
  const typical = recent.length > 1 ? recent.slice(1).reduce((t, r) => t + r.spend, 0) / (recent.length - 1) : null;
  const yesterdaySpend = recent[0]?.date === snap.yesterday && typical && recent[0].spend < typical * 0.5 ? recent[0].spend : null;

  const alarms = emergencies({
    today: todayRow,
    budgetTotal,
    accountStatus: snap.account.status,
    adIssues: adIssuesFrom(ads, activeIds),
    yesterdaySpend,
    // Empty ad lists mean the read failed, not that nothing runs.
    uncovered: ads.length ? languageCoverage({ campaigns: snap.structure.campaigns, adsets: snap.structure.adsets, ads }) : [],
  });
  for (const { whatsapp, ...e } of alarms) {
    const key = ["ads.disapproved", "ads.issues", "ads.language_gap"].includes(e.type) ? `${e.type}:${e.reason.slice(0, 120)}` : `${e.type}:${snap.today}`;
    await notice("ads", { ...e, payload: { dedupeKey: key, ...(whatsapp === false ? { whatsapp: false } : {}) } });
  }
  // New ads that have run 7+ days get their verdict against their ad set (feeds the idea library).
  // New ads launched together are judged together: one alert per ad set, not one per ad.
  const judged = await judgeNewAds().catch(() => []);
  const WORD = { win: "won", lose: "lost", even: "came out even", unclear: "got too little delivery" };
  const groups = new Map();
  for (const j of judged) {
    const key = j.creative.adsetId ?? j.creative.campaignId ?? String(j.creative._id);
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  for (const list of groups.values()) {
    const c0 = list[0].creative;
    const where = `${c0.campaignName}${c0.adsetName ? ` › ${c0.adsetName}` : ""}`;
    const label = (c) => `${IDEAS[c.idea]?.label ?? c.idea ?? "idea not tagged"} (${c.role ?? "test"})`;
    await notice("ads", {
      type: "ads.verdict",
      title: (list.length === 1
        ? `New ad ${WORD[list[0].verdict]}: ${where} (${label(c0)})`
        : `${list.length} new ads judged in ${where}: ${list.map((j) => `${IDEAS[j.creative.idea]?.label ?? "untagged"} ${WORD[j.verdict]}`).join(", ")}`
      ).slice(0, 160),
      reason: `${list.map((j) => `${label(j.creative)}: ${WORD[j.verdict]}. ${j.note}`).join("\n")}\nThe idea library now counts these results.${list.some((j) => j.verdict === "lose") ? " Ads this far behind are paused on the next batch day if they stay ≥ 1.8× their campaign." : ""}`,
      effect: "Alert only.",
      payload: { dedupeKey: `verdict:${list.map((j) => j.creative._id).join(",")}` },
    });
  }
  if (!weekly) {
    const braked = settings.brake !== false && config.modes.ads !== "off" ? await runBrakes(snap, settings, config).catch((err) => ({ error: err.message })) : null;
    return { snapshot: snap.today, alarms: alarms.length, judged: judged.length, decisions: 0, braked };
  }

  if (midweek && settings.midweekRaises === false) return { snapshot: snap.today, decisions: 0, skipped: "Mid-week raises are switched off" };
  const calib = await accountCalibration(snap.yesterday);
  const units = await buildUnits(snap.structure, snap.yesterday, snap.tz, settings, calib);
  if (!midweek) await checkAttribution(snap.today).catch(() => {});
  const result = decide({
    units,
    limits: config.limits,
    settings,
    calib,
    increasedThisWeek: await increasedThisWeek(),
    mode: midweek ? "midweek" : "weekly",
    noticeHours: config.limits.adNoticeHours,
  });
  let made = 0;
  for (const d of result.decisions) {
    await propose(
      "ads",
      {
        type: d.type,
        title: d.title,
        reason: d.reason,
        effect: d.effect,
        payload: d.payload,
        ref: { kind: "meta", id: d.unitId },
        runAt: hoursFromNow(config.limits.adNoticeHours),
      },
      { dedupeKey: `${d.type}:${d.unitId}` }
    );
    made++;
  }
  return {
    snapshot: snap.today,
    decisions: made,
    calib,
    average: result.average,
    states: result.evaluated.map((e) => ({ id: e.unit.id, name: e.unit.name, state: e.state, flags: e.flags, notes: e.notes })),
  };
};

/** Current state of every unit, for the Ads screen and the planners (no Meta call). */
export const unitStates = async () => {
  const config = await getConfig();
  applyTuning(config.algorithm?.tuning);
  const latest = await AdSnapshot.findOne({ level: "account" }).sort({ date: -1 }).lean();
  if (!latest) return [];
  const yesterday = new Date(Date.parse(latest.date) - DAY).toISOString().slice(0, 10);
  const todays = await AdSnapshot.find({ date: latest.date, level: { $in: ["campaign", "adset"] } }).lean();
  const structure = {
    campaigns: todays.filter((r) => r.level === "campaign").map((r) => ({ id: r.entityId, name: r.name, dailyBudget: r.dailyBudget, status: r.status ?? "ACTIVE" })),
    adsets: todays.filter((r) => r.level === "adset").map((r) => ({ id: r.entityId, name: r.name, campaignId: r.campaignId, dailyBudget: r.dailyBudget, status: r.status ?? "ACTIVE" })),
  };
  const calib = await accountCalibration(yesterday);
  const units = await buildUnits(structure, yesterday, TZ_FALLBACK, adsSettings(config), calib);
  const result = decide({ units, limits: config.limits, settings: { ...adsSettings(config), rebalance: false }, calib });
  return result.evaluated.map((e) => ({
    id: e.unit.id,
    campaignId: e.unit.campaignId,
    name: e.unit.name,
    language: e.unit.language,
    level: e.unit.level,
    dailyBudget: e.unit.dailyBudget,
    state: e.state,
    flags: e.flags,
    notes: e.notes,
    metrics: e.metrics,
  }));
};

/** Batch day: schedules pauses for ads that cost far more than their campaign. Returns the ad sets left thin. */
export const planAdPauses = async (runAt, { skipCampaigns = [] } = {}) => {
  const [ads, structure] = await Promise.all([fetchAds(), fetchStructure()]);
  // A campaign about to be restructured (the merge test) is left alone this batch.
  const activeCampaigns = new Set(structure.campaigns.filter((c) => c.status === "ACTIVE" && !skipCampaigns.includes(c.id)).map((c) => c.id));
  const activeSets = new Set(structure.adsets.filter((s) => s.status === "ACTIVE").map((s) => s.id));
  const live = ads.filter((a) => a.effective_status === "ACTIVE" && activeCampaigns.has(a.campaign_id) && activeSets.has(a.adset_id));
  const since = new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);
  const [adRows, campaignRows] = await Promise.all([
    AdSnapshot.aggregate([
      { $match: { level: "ad", date: { $gte: since } } },
      { $group: { _id: "$entityId", spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
    ]),
    AdSnapshot.aggregate([
      { $match: { level: "campaign", date: { $gte: since } } },
      { $group: { _id: "$entityId", spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
    ]),
  ]);
  const stat = new Map(adRows.map((r) => [r._id, r]));
  const campaignCpp14 = new Map(campaignRows.map((r) => [r._id, r.paid ? r.spend / r.paid : Infinity]));
  const { pauses, thin } = adDecisions({
    ads: live.map((a) => ({
      id: a.id,
      name: a.name,
      adsetId: a.adset_id,
      campaignId: a.campaign_id,
      createdAt: a.created_time,
      spend14: stat.get(a.id)?.spend ?? 0,
      paid14: stat.get(a.id)?.paid ?? 0,
    })),
    campaignCpp14,
  });
  const proposed = [];
  for (const p of pauses) {
    const left = live.filter((a) => a.adset_id === p.adsetId).length - pauses.filter((x) => x.adsetId === p.adsetId).length;
    proposed.push(
      await propose("ads", {
        type: "ads.pause_ad",
        title: `Pause ${p.name}`,
        reason: `${p.reason} It pulls its campaign's cost up; the other ads in the ad set take over its spend.`,
        effect: `Pauses this ad. Its ad set keeps ${left} active ad${left === 1 ? "" : "s"}.`,
        payload: { adId: p.adId, adsetId: p.adsetId, campaignId: p.campaignId, name: p.name },
        ref: { kind: "meta", id: `pause:${p.adId}` },
        runAt,
      })
    );
  }
  return { paused: proposed.filter(Boolean).length, thin };
};

handle("ads.budget", async (action) => {
  const { entityId, from, to } = action.payload;
  const structure = await fetchStructure();
  const current = [...structure.campaigns, ...structure.adsets].find((e) => e.id === entityId);
  if (!current) throw new Error("This campaign or ad set no longer exists");
  if (current.dailyBudget !== from) {
    throw new Error(`Budget is now ₹${current.dailyBudget}, not ₹${from}; someone changed it. Skipped so nothing is overwritten.`);
  }
  await setDailyBudget(entityId, to);
  return { from, to };
});

handleUndo("ads.budget", async (action) => {
  await setDailyBudget(action.payload.entityId, action.payload.from);
});

// Money moves from one unit to another: the cut runs first, so total spend never goes up.
handle("ads.rebalance", async (action) => {
  const { moves } = action.payload;
  const structure = await fetchStructure();
  const all = [...structure.campaigns, ...structure.adsets];
  for (const m of moves) {
    const current = all.find((e) => e.id === m.entityId);
    if (!current) throw new Error(`${m.name} no longer exists`);
    if (current.status !== "ACTIVE") throw new Error(`${m.name} is ${String(current.status).toLowerCase()}; not moving budget.`);
    if (current.dailyBudget !== m.from) {
      throw new Error(`${m.name} is now ₹${current.dailyBudget}/day, not ₹${m.from}; someone changed it. Skipped so nothing is overwritten.`);
    }
  }
  const done = [];
  try {
    for (const m of moves) {
      await setDailyBudget(m.entityId, m.to);
      done.push(m);
    }
  } catch (err) {
    for (const m of done.reverse()) await setDailyBudget(m.entityId, m.from).catch(() => {});
    throw err;
  }
  return { moves: moves.map((m) => ({ entityId: m.entityId, from: m.from, to: m.to })) };
});

handleUndo("ads.rebalance", async (action) => {
  // Receiver back down first, then the donor back up.
  for (const m of [...action.payload.moves].reverse()) await setDailyBudget(m.entityId, m.from);
});

handle("ads.pause_ad", async (action) => {
  const { adId, adsetId } = action.payload;
  const ads = await fetchAds();
  const ad = ads.find((a) => a.id === adId);
  if (!ad) throw new Error("This ad no longer exists");
  if (ad.effective_status !== "ACTIVE") return { skipped: `Already ${String(ad.effective_status).toLowerCase()}` };
  const activeInSet = ads.filter((a) => a.adset_id === adsetId && a.effective_status === "ACTIVE").length;
  if (activeInSet <= RULES.adMinActive) throw new Error(`Only ${activeInSet} active ads left in this ad set; not pausing.`);
  await setStatus(adId, "PAUSED");
  return { paused: adId };
});

handleUndo("ads.pause_ad", async (action) => {
  if (action.result?.paused) await setStatus(action.result.paused, "ACTIVE");
});

// Older queued refresh cards: running one just records it (new ones go through ads.creative_launch).
handle("ads.creative_refresh", async () => ({ recorded: true }));
