import User from "../models/User.js";
import Broker from "../models/Broker.js";
import { AdSnapshot, OpsAction, getConfig } from "./models.js";
import { decide, emergencies } from "./adsEngine.js";
import { handle, handleUndo, hoursFromNow, notice, propose } from "./actions.js";
import {
  dayIn,
  fetchAccount,
  fetchInsights,
  fetchStructure,
  graphAll,
  accountId,
  setDailyBudget,
} from "./meta.js";

/*
 * Meta ads for the ops agent: a daily snapshot of every campaign, ad set, ad
 * and placement (kept forever, so any window can be charted), the funds
 * check, and the weekly budget decisions from adsEngine.js.
 */

const TZ_FALLBACK = "Asia/Kolkata";

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

/** Real joins and net earnings per day from our own database. */
const joinsAndEarnings = async (since, tz) => {
  const sinceDate = new Date(`${since}T00:00:00Z`);
  const day = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: tz } });
  const NET = {
    $subtract: [
      { $ifNull: ["$transactions.amountPaid", 0] },
      { $add: [{ $ifNull: ["$transactions.amountRefunded", 0] }, { $ifNull: ["$transactions.referralRefunded", 0] }] },
    ],
  };
  const earnPipe = [
    { $unwind: "$transactions" },
    { $match: { "transactions.dateOfTrans": { $gte: sinceDate } } },
    { $group: { _id: day("$transactions.dateOfTrans"), earned: { $sum: NET } } },
  ];
  const [joins, e1, e2] = await Promise.all([
    User.aggregate([{ $match: { createdAt: { $gte: sinceDate } } }, { $group: { _id: day("$createdAt"), n: { $sum: 1 } } }]),
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

/** Average spend of the last 3 completed days. */
const avgSpend = async (yesterday) => {
  const rows = await AdSnapshot.find({ level: "account", date: { $lte: yesterday } }).sort({ date: -1 }).limit(3).lean();
  return rows.length ? rows.reduce((t, r) => t + r.spend, 0) / rows.length : 0;
};

/** Builds the budget-owning units from stored snapshots (completed days only). */
const buildUnits = async (structure, yesterday) => {
  const since = new Date(Date.parse(yesterday) - 13 * 86400000).toISOString().slice(0, 10);
  const active = (s) => s === "ACTIVE";
  const units = [];
  const lastChange = await lastChanges();

  for (const c of structure.campaigns.filter((c) => active(c.status))) {
    const sets = structure.adsets.filter((s) => s.campaignId === c.id && active(s.status));
    const adsetBudgets = sets.some((s) => s.dailyBudget);
    const owners = adsetBudgets ? sets.filter((s) => s.dailyBudget) : [c];
    for (const o of owners) {
      const level = adsetBudgets ? "adset" : "campaign";
      const rows = await AdSnapshot.find(
        level === "adset"
          ? { level: "adset", entityId: o.id, date: { $gte: since, $lte: yesterday } }
          : { level: "campaign", entityId: o.id, date: { $gte: since, $lte: yesterday } }
      ).sort({ date: 1 }).lean();
      // Campaign units use the highest ad-set frequency as their fatigue signal.
      if (level === "campaign" && rows.length) {
        const f = await AdSnapshot.find({ level: "adset", campaignId: o.id, date: yesterday }).lean();
        rows.at(-1).frequency7 = Math.max(0, ...f.map((x) => x.frequency7 ?? 0));
      }
      const edited = level === "adset" ? [o.updatedAt] : sets.map((s) => s.updatedAt);
      const agentChange = lastChange.get(o.id);
      units.push({
        id: o.id,
        campaignId: c.id,
        level,
        name: level === "adset" ? `${c.name} › ${o.name}` : c.name,
        dailyBudget: o.dailyBudget,
        days: rows,
        lastChangeAt: maxDate([...edited, agentChange?.any]),
        lastBudgetChangeAt: agentChange?.budget ?? null,
      });
    }
  }
  return units;
};

const maxDate = (dates) => {
  const t = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return t.length ? new Date(Math.max(...t)) : null;
};

/** When the agent last changed each entity (any change / budget change). */
const lastChanges = async () => {
  const done = await OpsAction.find({ module: "ads", status: "done", ranAt: { $gte: new Date(Date.now() - 30 * 86400000) } }).lean();
  const out = new Map();
  for (const a of done) {
    const id = a.payload?.entityId;
    if (!id) continue;
    const row = out.get(id) ?? {};
    row.any = maxDate([row.any, a.ranAt]);
    if (a.type === "ads.budget") row.budget = maxDate([row.budget, a.ranAt]);
    out.set(id, row);
  }
  return out;
};

/** ₹ of daily budget the agent added in the last 7 days. */
const increasedThisWeek = async () => {
  const done = await OpsAction.find({ type: "ads.budget", status: "done", ranAt: { $gte: new Date(Date.now() - 7 * 86400000) } }).lean();
  return done.reduce((t, a) => t + Math.max(0, (a.payload?.to ?? 0) - (a.payload?.from ?? 0)), 0);
};

/**
 * Daily: snapshot + emergencies. Weekly (or when forced): budget and
 * creative decisions, each with the configured notice period.
 */
export const runAdsCycle = async ({ weekly = false } = {}) => {
  const config = await getConfig();
  const snap = await takeSnapshot();
  const avg = await avgSpend(snap.yesterday);
  const funds = { available: snap.account.available ?? snap.account.spendCapLeft, avgDailySpend: avg };
  const budgetTotal = [...snap.structure.campaigns, ...snap.structure.adsets]
    .filter((e) => e.status === "ACTIVE" && e.dailyBudget)
    .reduce((t, e) => t + e.dailyBudget, 0);
  const todayRow = await AdSnapshot.findOne({ level: "account", date: snap.today }).lean();

  for (const e of emergencies({ funds, today: todayRow, budgetTotal })) {
    await notice("ads", { ...e, payload: { dedupeKey: `${e.type}:${snap.today}` } });
  }
  if (!weekly) return { snapshot: snap.today, decisions: 0 };

  const units = await buildUnits(snap.structure, snap.yesterday);
  const result = decide({ units, limits: config.limits, funds, increasedThisWeek: await increasedThisWeek() });
  let made = 0;
  // Creative refreshes are planned by the Monday "adsPlan" job (adsGrowth.js), not here.
  for (const d of result.decisions.filter((x) => x.type === "ads.budget")) {
    const isBudget = true;
    await propose(
      "ads",
      {
        type: d.type,
        title: d.title,
        reason: d.reason,
        effect: d.effect,
        payload: d.payload,
        ref: { kind: "meta", id: d.unitId },
        // Budget steps run after the notice period; creative refreshes need new artwork first.
        status: isBudget ? "scheduled" : "needs_you",
        runAt: isBudget ? hoursFromNow(config.limits.adNoticeHours) : undefined,
      },
      { dedupeKey: `${d.type}:${d.unitId}` }
    );
    made++;
  }
  return { snapshot: snap.today, decisions: made, states: result.evaluated.map((e) => ({ id: e.unit.id, name: e.unit.name, state: e.state, notes: e.notes, metrics: e.metrics })) };
};

/** Current state of every unit, for the Ads screen (no Meta call). */
export const unitStates = async () => {
  const config = await getConfig();
  const latest = await AdSnapshot.findOne({ level: "account" }).sort({ date: -1 }).lean();
  if (!latest) return [];
  const yesterday = new Date(Date.parse(latest.date) - 86400000).toISOString().slice(0, 10);
  const todays = await AdSnapshot.find({ date: latest.date, level: { $in: ["campaign", "adset"] } }).lean();
  const structure = {
    campaigns: todays.filter((r) => r.level === "campaign").map((r) => ({ id: r.entityId, name: r.name, dailyBudget: r.dailyBudget, status: r.status ?? "ACTIVE" })),
    adsets: todays.filter((r) => r.level === "adset").map((r) => ({ id: r.entityId, name: r.name, campaignId: r.campaignId, dailyBudget: r.dailyBudget, status: r.status ?? "ACTIVE" })),
  };
  const units = await buildUnits(structure, yesterday);
  return decide({ units, limits: config.limits, funds: { available: null, avgDailySpend: 0 } }).evaluated.map((e) => ({
    id: e.unit.id,
    campaignId: e.unit.campaignId,
    name: e.unit.name,
    level: e.unit.level,
    dailyBudget: e.unit.dailyBudget,
    state: e.state,
    notes: e.notes,
    metrics: e.metrics,
  }));
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

// Older queued refresh cards: running one just records it (new ones go through ads.creative_launch).
handle("ads.creative_refresh", async () => ({ recorded: true }));

handleUndo("ads.budget", async (action) => {
  await setDailyBudget(action.payload.entityId, action.payload.from);
});
