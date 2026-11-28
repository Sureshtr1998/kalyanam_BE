import { AdSnapshot, OpsAction, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { handle, handleUndo, hoursFromNow, notice, propose, undo } from "./actions.js";
import { adsSettings, lastBatchAt, planAdPauses, unitStates } from "./ads.js";
import { batchGate, languageOf } from "./adsEngine.js";
import { CLAIM_RULES, planCreativeRefresh, recreateAd, tiredAdset } from "./adsCreative.js";
import {
  copyAdset,
  fetchAds,
  fetchAdset,
  fetchStructure,
  graphPost,
  searchLocation,
  setDailyBudget,
  setStatus,
  usesAdvantageAudience,
} from "./meta.js";

/*
 * Batch days for ad and ad-set changes (Monday job "adsPlan"). Every
 * significant edit sends an ad set back into Meta's learning phase, so all
 * of them are scheduled together, at most every `batchEveryDays` (14) and
 * never before the owner's hands-off date:
 *  1. pause ads that cost far more per member than their campaign;
 *  2. fresh ads for tired ad sets and for ad sets left with 2 ads;
 *  3. a new ad set, only when switched on (off by default: at today's
 *     volume each ad set gets about 25 members a week, under the ~50 Meta
 *     needs to finish learning, and a new ad set would split them further).
 * Budget moves are weekly and separate (ads.js), as ±20% steps don't reset learning.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposal"],
  properties: {
    proposal: {
      type: "object",
      additionalProperties: false,
      required: ["expand", "campaignId", "baseAdsetId", "name", "locations", "ageMin", "ageMax", "gender", "dailyBudget", "reason", "expected"],
      properties: {
        expand: { type: "boolean", description: "false when no expansion is justified (other fields then empty)" },
        campaignId: { type: "string" },
        baseAdsetId: { type: "string", description: "Existing ad set to copy (best performer in that campaign)" },
        name: { type: "string", description: "Follow the naming of the existing ad sets in that campaign" },
        locations: { type: "array", items: { type: "string" }, description: "City, state or country names, e.g. 'Hyderabad', 'Karnataka'" },
        ageMin: { type: "integer" },
        ageMax: { type: "integer" },
        gender: { type: "string", enum: ["all", "men", "women"] },
        dailyBudget: { type: "integer", description: "₹ per day" },
        reason: { type: "string" },
        expected: { type: "string", description: "What success looks like after 7 days, with a number" },
      },
    },
  },
};

/** Members a week an ad set should already be getting before the agent splits a campaign further. */
const MIN_WEEKLY_PAID_TO_EXPAND = 35;

/** One new ad set proposal, if switched on and the numbers support one. */
export const planNewAdset = async (runAt = hoursFromNow(24)) => {
  const config = await getConfig();
  const settings = adsSettings(config);
  if (!settings.newAdsets) return { skipped: "New ad sets are switched off (Ops → Settings → Ads rules)" };
  const recent = await OpsAction.exists({ type: "ads.new_adset", status: { $ne: "cancelled" }, createdAt: { $gte: new Date(Date.now() - 14 * 86400000) } });
  if (recent) return { skipped: "Already proposed a new ad set in the last 14 days" };

  const structure = await fetchStructure();
  const activeCampaigns = structure.campaigns.filter((c) => c.status === "ACTIVE");
  const adsets = structure.adsets.filter((s) => s.status === "ACTIVE" && activeCampaigns.some((c) => c.id === s.campaignId));
  const totalBudget = [...activeCampaigns, ...adsets].reduce((t, e) => t + (e.dailyBudget || 0), 0);
  const headroom = config.limits.maxDailySpend - totalBudget;
  if (headroom < 300) return { skipped: "No room under the max daily spend" };

  const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const [perAdset7, perAdset14] = await Promise.all(
    [since7, since14].map((since) =>
      AdSnapshot.aggregate([
        { $match: { level: "adset", date: { $gte: since } } },
        { $group: { _id: "$entityId", spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
      ])
    )
  );
  const week = new Map(perAdset7.map((r) => [r._id, r]));
  const stat = new Map(perAdset14.map((r) => [r._id, r]));
  if (!adsets.some((a) => (week.get(a.id)?.paid ?? 0) >= MIN_WEEKLY_PAID_TO_EXPAND)) {
    return { skipped: `No ad set gets ${MIN_WEEKLY_PAID_TO_EXPAND}+ members a week yet; a new ad set would split Meta's learning further` };
  }
  const states = await unitStates();
  const maxBudget = Math.min(1000, Math.floor(headroom / 10) * 10);

  const { proposal } = await ask({
    task: "ads.growth",
    tier: "ads",
    system: `You grow Meta ads for Seetha Rama Kalyana, a matrimony site.
${config.brief}
${CLAIM_RULES}
Owner's standing rules (follow them exactly):
${settings.preferences ?? ""}
Account rules: one campaign per language; audiences are ad sets inside it. Only propose a new ad set when its language is clearly profitable (real cost per member well under ₹${config.limits.losingCostPerMember}) and an existing ad set already gets ${MIN_WEEKLY_PAID_TO_EXPAND}+ members a week, to reach families the current ad sets don't. Set expand=false otherwise. Budget ₹300–${maxBudget}/day.`,
    prompt: `Campaigns and ad sets (14 days):
${activeCampaigns
  .map((c) => {
    const s = adsets.filter((a) => a.campaignId === c.id);
    return `${c.name} [${c.id}] budget ${c.dailyBudget ? `₹${c.dailyBudget}` : "per ad set"}\n${s
      .map((a) => {
        const r = stat.get(a.id);
        return `  - ${a.name} [${a.id}] ${a.dailyBudget ? `₹${a.dailyBudget}/day ` : ""}spend ₹${Math.round(r?.spend ?? 0)}, paid ${r?.paid ?? 0}, per member ${r?.paid ? `₹${Math.round(r.spend / r.paid)}` : "–"}, last 7 days ${week.get(a.id)?.paid ?? 0} members`;
      })
      .join("\n")}`;
  })
  .join("\n")}
States: ${states.map((s) => `${s.name}: ${s.state}`).join("; ")}
Room under the daily cap: ₹${headroom}.`,
    schema: SCHEMA,
    maxTokens: 8000,
  });
  if (!proposal?.expand) return { skipped: "No expansion justified" };

  const base = adsets.find((a) => a.id === proposal.baseAdsetId && a.campaignId === proposal.campaignId);
  if (!base) return { skipped: "Proposal pointed at an unknown ad set" };
  const budget = Math.max(300, Math.min(maxBudget, Math.round(proposal.dailyBudget / 10) * 10));
  const action = await propose("ads", {
    type: "ads.new_adset",
    title: `New ad set: ${proposal.name} at ₹${budget}/day`,
    reason: `${proposal.reason} Expected: ${proposal.expected}`,
    effect: `Copies "${base.name}" with its 3 best ads, targets ${proposal.locations.join(", ")}, ages ${proposal.ageMin}–${proposal.ageMax}${proposal.gender === "all" ? "" : `, ${proposal.gender}`} (only suggestions if Advantage+ audience is on), and starts it at ₹${budget}/day.`,
    payload: { ...proposal, expand: undefined, dailyBudget: budget, campaignId: base.campaignId, baseAdsetId: base.id, baseHasBudget: !!base.dailyBudget },
    ref: { kind: "meta", id: `new-adset:${proposal.name}` },
    runAt,
  });
  return { proposed: action?._id ?? null };
};

/** Monday job: one batch of ad and ad-set changes, when the batch rules allow it. */
export const runAdsPlanning = async () => {
  const config = await getConfig();
  const settings = adsSettings(config);
  // The merge test's 14-day result, whether or not this is a batch week.
  await judgeMergeTest().catch((err) => console.error("[ops] merge test", err.message));
  const gate = batchGate({ settings, lastBatchAt: await lastBatchAt() });
  if (!gate.open) return { skipped: gate.reason };
  // Everything in a batch goes live at the same moment, after the notice period.
  const runAt = hoursFromNow(config.limits.adNoticeHours);
  const results = [];

  // The merge test restructures its language: no pauses or fresh ads there in the same batch.
  const merge = await OpsAction.findOne({ type: "ads.merge_test", status: { $in: ["scheduled", "shadow"] } }).lean();
  const skipCampaigns = merge ? [merge.payload.campaignId] : [];
  let thin = [];
  if (settings.pauseLosingAds !== false) {
    try {
      const r = await planAdPauses(runAt, { skipCampaigns });
      thin = r.thin;
      results.push({ pauses: r.paused });
    } catch (err) {
      results.push({ pauses: "error", error: err.message });
    }
  }

  // Fresh ads: tired units first, then ad sets left with 2 ads; at most 2 ad sets per batch.
  const states = await unitStates();
  const targets = new Map();
  for (const u of states.filter((s) => s.flags?.tired)) {
    const set = u.level === "adset" ? { adsetId: u.id, adsetName: u.name.split(" › ").pop() } : await tiredAdset(u.campaignId);
    if (set && !targets.has(set.adsetId)) targets.set(set.adsetId, { ...set, campaignId: u.campaignId, campaignName: u.name.split(" › ")[0], notes: u.notes });
  }
  if (thin.length) {
    const names = new Map((await AdSnapshot.find({ level: "adset", entityId: { $in: thin.map((t) => t.adsetId) } }).sort({ date: -1 }).lean()).map((r) => [r.entityId, r]));
    for (const t of thin) {
      const row = names.get(t.adsetId);
      const campaign = states.find((s) => s.campaignId === t.campaignId);
      if (!targets.has(t.adsetId) && campaign) {
        targets.set(t.adsetId, { adsetId: t.adsetId, adsetName: row?.name ?? "", campaignId: t.campaignId, campaignName: campaign.name.split(" › ")[0], notes: [`Only ${t.active} ads left running in this ad set after this batch's pauses.`] });
      }
    }
  }
  for (const t of [...targets.values()].filter((x) => !skipCampaigns.includes(x.campaignId)).slice(0, 2)) {
    try {
      results.push(await planCreativeRefresh({ ...t, runAt }));
    } catch (err) {
      results.push({ adset: t.adsetName, error: err.message });
    }
  }

  try {
    results.push(await planNewAdset(runAt));
  } catch (err) {
    results.push({ growth: "error", error: err.message });
  }
  return results;
};

handle("ads.new_adset", async (action) => {
  const p = action.payload;
  const config = await getConfig();
  const structure = await fetchStructure();
  const total = [...structure.campaigns, ...structure.adsets].filter((e) => e.status === "ACTIVE").reduce((t, e) => t + (e.dailyBudget || 0), 0);
  if (total + p.dailyBudget > config.limits.maxDailySpend) throw new Error(`Would take daily budgets past the ₹${config.limits.maxDailySpend} limit`);

  const base = await fetchAdset(p.baseAdsetId);
  const geo = { cities: [], regions: [], countries: [] };
  for (const name of p.locations.slice(0, 10)) {
    const loc = await searchLocation(name);
    if (!loc) continue;
    if (loc.type === "city") geo.cities.push({ key: loc.key, radius: 25, distance_unit: "kilometer" });
    else if (loc.type === "region") geo.regions.push({ key: loc.key });
    else if (loc.type === "country") geo.countries.push(loc.country_code ?? loc.key);
  }
  if (!geo.cities.length && !geo.regions.length && !geo.countries.length) throw new Error(`Meta found none of these places: ${p.locations.join(", ")}`);
  for (const k of Object.keys(geo)) if (!geo[k].length) delete geo[k];

  // Shallow copy, then the base ad set's best ads one by one (a deep copy of 4+ ads exceeds Meta's sync limit).
  const newId = await copyAdset(p.baseAdsetId);
  if (!newId) throw new Error("Meta didn't return the copied ad set");
  const advantage = usesAdvantageAudience(base.targeting);
  const targeting = { ...base.targeting, geo_locations: geo };
  // With Advantage+ audience Meta treats ages and gender as suggestions and rejects age_min above 25, so those stay as they were.
  if (!advantage) {
    targeting.age_min = p.ageMin;
    targeting.age_max = p.ageMax;
    if (p.gender === "men") targeting.genders = [1];
    else if (p.gender === "women") targeting.genders = [2];
    else delete targeting.genders;
  }
  await graphPost(newId, { name: p.name, targeting, ...(p.baseHasBudget ? { daily_budget: String(p.dailyBudget * 100) } : {}) });

  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const stats = new Map(
    (
      await AdSnapshot.aggregate([
        { $match: { level: "ad", adsetId: p.baseAdsetId, date: { $gte: since } } },
        { $group: { _id: "$entityId", spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
      ])
    ).map((r) => [r._id, r])
  );
  const cpp = (id) => (stats.get(id)?.paid ? stats.get(id).spend / stats.get(id).paid : Infinity);
  const baseAds = (await fetchAds()).filter((a) => a.adset_id === p.baseAdsetId && a.effective_status === "ACTIVE").sort((a, b) => cpp(a.id) - cpp(b.id)).slice(0, 3);
  if (!baseAds.length) throw new Error("The ad set to copy has no active ads");
  const adIds = [];
  for (const a of baseAds) {
    // Made fresh, not copied: Meta refuses to copy ads made with the retired standard enhancements.
    const id = await recreateAd(a.id, newId, a.name);
    if (id) {
      await setStatus(id, "ACTIVE");
      adIds.push(id);
    }
  }

  // Campaign-level budget: raise the campaign by the same amount so existing ad sets keep theirs.
  let campaignBudget = null;
  if (!p.baseHasBudget) {
    const c = structure.campaigns.find((x) => x.id === p.campaignId);
    if (c?.dailyBudget) {
      campaignBudget = { from: c.dailyBudget, to: c.dailyBudget + p.dailyBudget };
      await setDailyBudget(p.campaignId, campaignBudget.to);
    }
  }
  await setStatus(newId, "ACTIVE");
  return { adsetId: newId, ads: adIds.length, advantageAudience: advantage, campaignBudget, entityId: newId };
});

handleUndo("ads.new_adset", async (action) => {
  await setStatus(action.result.adsetId, "PAUSED");
  const cb = action.result.campaignBudget;
  if (cb) await setDailyBudget(action.payload.campaignId, cb.from);
});

/** A new ad set from a given plan (an owner's idea), with the same budget checks as the planner. */
export const proposeIdeaAdset = async (plan, { runAt, reason, ideaId }) => {
  const config = await getConfig();
  const structure = await fetchStructure();
  const adsets = structure.adsets.filter((s) => s.status === "ACTIVE");
  const base = adsets.find((a) => a.id === plan.baseAdsetId) ?? adsets.find((a) => a.campaignId === plan.campaignId);
  if (!base) throw new Error("No active ad set in that campaign to copy");
  const total = [...structure.campaigns, ...adsets].filter((e) => e.status === "ACTIVE").reduce((t, e) => t + (e.dailyBudget || 0), 0);
  const headroom = config.limits.maxDailySpend - total;
  if (headroom < 200) throw new Error(`No room under the ₹${config.limits.maxDailySpend}/day limit (raise it in Settings → Limits)`);
  const budget = Math.max(200, Math.min(headroom, Math.round((plan.dailyBudget || 300) / 10) * 10));
  return propose("ads", {
    type: "ads.new_adset",
    title: `New ad set: ${plan.name} at ₹${budget}/day`,
    reason,
    effect: `Copies "${base.name}" with its 3 best ads, targets ${plan.locations.join(", ")}, ages ${plan.ageMin}–${plan.ageMax}${plan.gender === "all" ? "" : `, ${plan.gender}`} (only suggestions if Advantage+ audience is on), and starts it at ₹${budget}/day.`,
    payload: { ...plan, dailyBudget: budget, campaignId: base.campaignId, baseAdsetId: base.id, baseHasBudget: !!base.dailyBudget, ideaId },
    ref: { kind: "meta", id: `idea-adset:${ideaId}:${plan.name}` },
    runAt,
  });
};

/*
 * Structure test (owner asked 28 Nov 2026): one language's two ad sets merged
 * into one, so Meta gets about twice the sign-ups per ad set to learn from
 * (each gets ~25 a week; Meta wants ~50). Waits for the owner's approval;
 * judged after 14 days against the 14 days before; Undo restores the two.
 */
export const MERGE_TEST_LANGUAGE = "Hindi";

/** Both ad sets' places and ages in one targeting (the first ad set's other settings). */
export const mergeTargeting = (a = {}, b = {}) => {
  const t = { ...a };
  t.age_min = Math.min(a.age_min ?? 18, b.age_min ?? 18);
  t.age_max = Math.max(a.age_max ?? 65, b.age_max ?? 65);
  const geo = { ...(a.geo_locations ?? {}) };
  const keyOf = (x) => (typeof x === "string" ? x : x?.key ?? JSON.stringify(x));
  for (const [k, v] of Object.entries(b.geo_locations ?? {})) {
    if (!Array.isArray(v)) continue;
    const current = Array.isArray(geo[k]) ? geo[k] : [];
    const seen = new Set(current.map(keyOf));
    geo[k] = [...current, ...v.filter((x) => !seen.has(keyOf(x)))];
  }
  t.geo_locations = geo;
  return t;
};

/**
 * When the next batch of ad changes goes live: the first Tuesday 10:30 am IST
 * on or after the batch gate opens (Monday's batch cards run Tuesday ~10 am).
 */
export const nextBatchRunAt = async (now = Date.now()) => {
  const config = await getConfig();
  const settings = adsSettings(config);
  const last = await lastBatchAt();
  const opens = Math.max(now, last ? new Date(last).getTime() + (settings.batchEveryDays ?? 14) * 86400000 : now, settings.handsOffUntil ? new Date(settings.handsOffUntil).getTime() : 0);
  const ist = new Date(opens + 5.5 * 3600000);
  const daysToTue = (2 - ist.getUTCDay() + 7) % 7 || (ist.getUTCHours() * 60 + ist.getUTCMinutes() >= 630 ? 7 : 0);
  const at = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysToTue, 10, 30) - 5.5 * 3600000;
  return new Date(at);
};

const mergeEffect = (language, parents, young, runAt) =>
  `Runs by itself on the next batch day (${runAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}), with that batch, so ${language} re-learns once: makes the merged ad set with the 2 best ads from each, turns it on, and pauses "${parents}" and "${young}". After 14 days: if ${language} got 10%+ dearer, the agent undoes it by itself; otherwise it stays. Cancel to skip the test.`;

/** The test card, once; it runs by itself on the next batch day. */
export const proposeMergeTest = async ({ language = MERGE_TEST_LANGUAGE } = {}) => {
  if (await OpsAction.exists({ type: "ads.merge_test", status: { $ne: "cancelled" } })) return null;
  const structure = await fetchStructure();
  const campaign = structure.campaigns.find((c) => c.status === "ACTIVE" && languageOf(c.name) === language);
  if (!campaign) return null;
  const sets = structure.adsets.filter((s) => s.campaignId === campaign.id && s.status === "ACTIVE");
  const parents = sets.find((s) => /parent/i.test(s.name));
  const young = sets.find((s) => /young/i.test(s.name));
  if (!parents || !young) return null;
  const runAt = await nextBatchRunAt();
  return propose("ads", {
    type: "ads.merge_test",
    runAt,
    title: `Test: merge ${language}'s Parents and Young ad sets into one`,
    reason: `Each ad set gets about 25 sign-ups a week, and Meta needs about 50 to finish learning, so none ever does. One merged ad set (ages 24–65, both ad sets' places) gives Meta twice the data. ${language} has the largest budget, so the test reads fastest. After 14 days the agent compares ${language}'s cost per member with the 14 days before and tells you.`,
    effect: mergeEffect(language, parents.name, young.name, runAt),
    payload: { campaignId: campaign.id, campaignName: campaign.name, language, parentsId: parents.id, youngId: young.id, parentsName: parents.name, youngName: young.name },
    ref: { kind: "meta", id: `merge-test:${campaign.id}` },
  });
};

/** The 2 cheapest running ads per ad set over 14 days. */
const bestAds = async (adsetIds, n = 2) => {
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const rows = await AdSnapshot.aggregate([
    { $match: { level: "ad", adsetId: { $in: adsetIds }, date: { $gte: since } } },
    { $group: { _id: "$entityId", spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
  ]);
  const stat = new Map(rows.map((r) => [r._id, r]));
  const cpp = (id) => (stat.get(id)?.paid ? stat.get(id).spend / stat.get(id).paid : Infinity);
  const live = (await fetchAds()).filter((a) => adsetIds.includes(a.adset_id) && a.effective_status === "ACTIVE");
  return adsetIds.flatMap((id) => live.filter((a) => a.adset_id === id).sort((a, b) => cpp(a.id) - cpp(b.id)).slice(0, n));
};

handle("ads.merge_test", async (action) => {
  const p = action.payload;
  const [parents, young] = await Promise.all([fetchAdset(p.parentsId), fetchAdset(p.youngId)]);
  const best = await bestAds([p.parentsId, p.youngId]);
  if (!best.length) throw new Error("No running ads in those ad sets to carry over");
  const newId = await copyAdset(p.parentsId);
  if (!newId) throw new Error("Meta didn't return the copied ad set");
  const adIds = [];
  try {
    await graphPost(newId, { name: `${p.language} | Parents + Young | 24-65 (merge test)`, targeting: mergeTargeting(parents.targeting, young.targeting) });
    for (const a of best) {
      const id = await recreateAd(a.id, newId, a.name);
      await setStatus(id, "ACTIVE");
      adIds.push(id);
    }
    await setStatus(newId, "ACTIVE");
  } catch (err) {
    // Nothing half-made stays on: the old ad sets keep running.
    await setStatus(newId, "PAUSED").catch(() => {});
    throw err;
  }
  await setStatus(p.parentsId, "PAUSED");
  await setStatus(p.youngId, "PAUSED");
  return { adsetId: newId, adIds, paused: [p.parentsId, p.youngId], entityId: newId };
});

handleUndo("ads.merge_test", async (action) => {
  for (const id of action.result?.paused ?? []) await setStatus(id, "ACTIVE");
  if (action.result?.adsetId) await setStatus(action.result.adsetId, "PAUSED");
});

/** Once: the card made earlier (waiting for approval) is scheduled for the next batch day instead. */
export const scheduleMergeTest = async () => {
  const card = await OpsAction.findOne({ type: "ads.merge_test", status: "needs_you" });
  if (!card) return null;
  const runAt = await nextBatchRunAt();
  card.status = "scheduled";
  card.runAt = runAt;
  card.effect = mergeEffect(card.payload.language, card.payload.parentsName, card.payload.youngName, runAt);
  return card.save();
};

/** 14 days after the merge: the language's cost per member after vs the 14 days before, once. */
export const judgeMergeTest = async (now = Date.now()) => {
  const t = await OpsAction.findOne({ type: "ads.merge_test", status: "done", "result.verdictAt": null, ranAt: { $lte: new Date(now - 14 * 86400000) } });
  if (!t) return null;
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const ran = new Date(t.ranAt).getTime();
  const window = async (from, to) => {
    const rows = await AdSnapshot.find({ level: "campaign", entityId: t.payload.campaignId, date: { $gte: day(from), $lt: day(to) } }).lean();
    const spend = rows.reduce((s, r) => s + (r.spend || 0), 0);
    const paid = rows.reduce((s, r) => s + (r.paid || 0), 0);
    return { spend, paid, cpp: paid ? spend / paid : null };
  };
  const [before, after] = await Promise.all([window(ran - 14 * 86400000, ran), window(ran, ran + 14 * 86400000)]);
  const ratio = before.cpp && after.cpp ? after.cpp / before.cpp : null;
  const verdict = ratio == null ? "unclear" : ratio <= 0.9 ? "better" : ratio >= 1.1 ? "worse" : "even";
  const rs = (n) => (n == null ? "–" : `₹${Math.round(n)}`);
  const word = { better: "cheaper", worse: "dearer", even: "about the same", unclear: "not enough data" }[verdict];
  // Dearer: put the two ad sets back by itself. Otherwise the merged one stays.
  let undone = false;
  if (verdict === "worse") undone = !!(await undo(t._id, "agent").catch((err) => console.error("[ops] merge undo", err.message)));
  await notice("ads", {
    type: "ads.merge_test_result",
    priority: "normal",
    title: `Merge test in ${t.payload.language}: ${word}`,
    reason: `${rs(after.cpp)} per member in the 14 days after the merge (${after.paid} members) vs ${rs(before.cpp)} in the 14 days before (${before.paid}).`,
    effect:
      verdict === "worse"
        ? undone
          ? "Undone by itself: the two old ad sets are back on and the merged one is paused."
          : "It couldn't be undone by itself: press Pause / undo on the test card."
        : "Kept: the merged ad set stays. Nothing to do.",
    payload: { dedupeKey: `merge_result:${t._id}` },
  });
  const fresh = await OpsAction.findById(t._id);
  fresh.result = { ...fresh.result, verdictAt: new Date(), verdict, before, after };
  fresh.markModified("result");
  await fresh.save();
  return verdict;
};
