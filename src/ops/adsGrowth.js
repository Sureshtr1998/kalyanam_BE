import { AdSnapshot, OpsAction, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { handle, handleUndo, hoursFromNow, propose } from "./actions.js";
import { unitStates } from "./ads.js";
import { planCreativeRefresh } from "./adsCreative.js";
import { copyAdset, fetchAds, fetchAdset, fetchStructure, graphPost, searchLocation, setDailyBudget, setStatus } from "./meta.js";

/*
 * New ad sets, chosen and scheduled by the agent (the owner cancels or
 * pauses what they don't want). Rules:
 *  - only inside the existing language campaigns, named "Language | Place | Audience"
 *  - at most one new ad set a week, budget within the account limits
 *  - never while prepaid funds cover fewer than minRunwayDays
 *  - built by copying an existing ad set (keeps pixel, optimisation and ads),
 *    then changing its locations, ages and name
 * Also runs the weekly creative refresh for tired units (adsCreative.js).
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
            name: { type: "string", description: "Language | Place | Audience" },
            locations: { type: "array", items: { type: "string" }, description: "City, state or country names, e.g. 'Hyderabad', 'Karnataka', 'United States'" },
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

/** One new ad set proposal per week, if the numbers support one. */
export const planNewAdset = async () => {
  const config = await getConfig();
  const recent = await OpsAction.exists({ type: "ads.new_adset", status: { $ne: "cancelled" }, createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } });
  if (recent) return { skipped: "Already proposed a new ad set this week" };

  const structure = await fetchStructure();
  const activeCampaigns = structure.campaigns.filter((c) => c.status === "ACTIVE");
  const adsets = structure.adsets.filter((s) => s.status === "ACTIVE");
  const totalBudget = [...activeCampaigns, ...adsets].reduce((t, e) => t + (e.dailyBudget || 0), 0);
  const headroom = config.limits.maxDailySpend - totalBudget;
  if (headroom < 200) return { skipped: "No room under the max daily spend" };

  const latest = await AdSnapshot.findOne({ level: "account", funds: { $ne: null } }).sort({ date: -1 }).lean();
  const last3 = await AdSnapshot.find({ level: "account" }).sort({ date: -1 }).skip(1).limit(3).lean();
  const avg = last3.reduce((t, r) => t + r.spend, 0) / (last3.length || 1);
  if (latest?.funds != null && avg && latest.funds / avg < config.limits.minRunwayDays) return { skipped: "Prepaid funds too low to expand" };

  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const perAdset = await AdSnapshot.aggregate([
    { $match: { level: "adset", date: { $gte: since } } },
    { $group: { _id: "$entityId", spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
  ]);
  const stat = new Map(perAdset.map((r) => [r._id, r]));
  const states = await unitStates();
  const maxBudget = Math.min(1000, Math.floor(headroom / 10) * 10);

  const { proposal } = await ask({
    task: "ads.growth",
    tier: "write",
    system: `You grow Meta ads for Seetha Rama Kalyana, a matrimony site.
${config.brief}
Account rules: one campaign per language; places and audiences are ad sets inside it, named "Language | Place | Audience". Only propose a new ad set when the language is profitable enough to expand (cost per paid member well under ₹${config.limits.losingCostPerMember}), to reach families the current ad sets don't (another city or state with that language's diaspora, NRIs, parents vs young professionals). Set expand=false when no expansion is justified. Budget ₹300–${maxBudget}/day.`,
    prompt: `Campaigns and ad sets (14 days):
${activeCampaigns
  .map((c) => {
    const s = adsets.filter((a) => a.campaignId === c.id);
    return `${c.name} [${c.id}] budget ${c.dailyBudget ? `₹${c.dailyBudget}` : "per ad set"}\n${s
      .map((a) => {
        const r = stat.get(a.id);
        return `  - ${a.name} [${a.id}] ${a.dailyBudget ? `₹${a.dailyBudget}/day ` : ""}spend ₹${Math.round(r?.spend ?? 0)}, paid ${r?.paid ?? 0}, per member ${r?.paid ? `₹${Math.round(r.spend / r.paid)}` : "–"}`;
      })
      .join("\n")}`;
  })
  .join("\n")}
States: ${states.map((s) => `${s.name}: ${s.state}`).join("; ")}
Room under the daily cap: ₹${headroom}.`,
    schema: SCHEMA,
    maxTokens: 1500,
  });
  if (!proposal?.expand) return { skipped: "No expansion justified this week" };

  const base = adsets.find((a) => a.id === proposal.baseAdsetId && a.campaignId === proposal.campaignId);
  if (!base) return { skipped: "Proposal pointed at an unknown ad set" };
  const budget = Math.max(200, Math.min(maxBudget, Math.round(proposal.dailyBudget / 10) * 10));
  const action = await propose("ads", {
    type: "ads.new_adset",
    title: `New ad set: ${proposal.name} at ₹${budget}/day`,
    reason: `${proposal.reason} Expected: ${proposal.expected}`,
    effect: `Copies "${base.name}" (same ads and tracking), targets ${proposal.locations.join(", ")}, ages ${proposal.ageMin}–${proposal.ageMax}${proposal.gender === "all" ? "" : `, ${proposal.gender}`}, and starts it at ₹${budget}/day.`,
    payload: { ...proposal, expand: undefined, dailyBudget: budget, campaignId: base.campaignId, baseAdsetId: base.id, baseHasBudget: !!base.dailyBudget },
    ref: { kind: "meta", id: `new-adset:${proposal.name}` },
    runAt: hoursFromNow(config.limits.adNoticeHours),
  });
  return { proposed: action?._id ?? null };
};

/** Monday job: fresh creatives for tired units (max 2 a week) and one growth idea. */
export const runAdsPlanning = async () => {
  const states = await unitStates();
  const tired = states.filter((s) => s.state === "tired").slice(0, 2);
  const results = [];
  for (const u of tired) {
    try {
      results.push(await planCreativeRefresh(u));
    } catch (err) {
      results.push({ unit: u.name, error: err.message });
    }
  }
  try {
    results.push(await planNewAdset());
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

  const newId = await copyAdset(p.baseAdsetId);
  if (!newId) throw new Error("Meta didn't return the copied ad set");
  const targeting = {
    ...base.targeting,
    geo_locations: geo,
    age_min: p.ageMin,
    age_max: p.ageMax,
    ...(p.gender === "men" ? { genders: [1] } : p.gender === "women" ? { genders: [2] } : {}),
  };
  if (p.gender === "all") delete targeting.genders;
  await graphPost(newId, { name: p.name, targeting, ...(p.baseHasBudget ? { daily_budget: String(p.dailyBudget * 100) } : {}) });

  // Campaign-level budget: raise the campaign by the same amount so existing ad sets keep theirs.
  let campaignBudget = null;
  if (!p.baseHasBudget) {
    const c = structure.campaigns.find((x) => x.id === p.campaignId);
    if (c?.dailyBudget) {
      campaignBudget = { from: c.dailyBudget, to: c.dailyBudget + p.dailyBudget };
      await setDailyBudget(p.campaignId, campaignBudget.to);
    }
  }
  const ads = (await fetchAds()).filter((a) => a.adset_id === newId);
  for (const a of ads) await setStatus(a.id, "ACTIVE");
  await setStatus(newId, "ACTIVE");
  return { adsetId: newId, ads: ads.length, campaignBudget, entityId: newId };
});

handleUndo("ads.new_adset", async (action) => {
  await setStatus(action.result.adsetId, "PAUSED");
  const cb = action.result.campaignBudget;
  if (cb) await setDailyBudget(action.payload.campaignId, cb.from);
});

/** A new ad set from a given plan (an owner's idea), with the same checks as the weekly planner. */
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
    effect: `Copies "${base.name}" (same ads and tracking), targets ${plan.locations.join(", ")}, ages ${plan.ageMin}–${plan.ageMax}${plan.gender === "all" ? "" : `, ${plan.gender}`}, and starts it at ₹${budget}/day.`,
    payload: { ...plan, dailyBudget: budget, campaignId: base.campaignId, baseAdsetId: base.id, baseHasBudget: !!base.dailyBudget, ideaId },
    ref: { kind: "meta", id: `idea-adset:${ideaId}:${plan.name}` },
    runAt,
  });
};
