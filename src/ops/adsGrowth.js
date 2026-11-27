import { AdSnapshot, OpsAction, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { handle, handleUndo, hoursFromNow, propose } from "./actions.js";
import { adsSettings, lastBatchAt, planAdPauses, unitStates } from "./ads.js";
import { batchGate } from "./adsEngine.js";
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
  const gate = batchGate({ settings, lastBatchAt: await lastBatchAt() });
  if (!gate.open) return { skipped: gate.reason };
  // Everything in a batch goes live at the same moment, after the notice period.
  const runAt = hoursFromNow(config.limits.adNoticeHours);
  const results = [];

  let thin = [];
  if (settings.pauseLosingAds !== false) {
    try {
      const r = await planAdPauses(runAt);
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
  for (const t of [...targets.values()].slice(0, 2)) {
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
