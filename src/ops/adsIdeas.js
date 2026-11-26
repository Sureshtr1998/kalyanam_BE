import User from "../models/User.js";
import { AdSnapshot, OpsComment, OpsCreative, OpsMail, OpsReport, getConfig } from "./models.js";
import { getPricing } from "../utils/pricing.js";
import { languageOf } from "./adsEngine.js";

/*
 * The ad idea engine: which message to put in front of which families.
 *
 *  1. Idea library: every ad (the owner's and the agent's) is tagged with
 *     one idea from IDEAS. Results add up per idea × language × audience
 *     (cost per paid member over 60 days), so the agent knows that, say,
 *     "community" works for Kannada parents and "safety" didn't for Telugu.
 *  2. Picker: each batch, a tired ad set gets one variant on its best
 *     PROVEN idea (new words and design) and one TEST of the most
 *     promising idea not yet tried there (judged by how it did in the other
 *     languages for the same audience).
 *  3. Sources for the writer (adsCreative.js): the actual images of the
 *     best and worst ads, families' own questions and doubts from comments
 *     and support mail, the brides' share of sign-ups, the messages of
 *     organic posts that brought sign-ups (message only: posts never become
 *     ads), and the season.
 *  4. Verdict: 7+ days after launch, each new ad is marked win / even /
 *     lose against its ad set, which also feeds the library.
 * The same rules are written out in the meta-ads-playbook skill.
 */

const DAY = 86400000;

/** The idea catalogue. `match` tags the owner's ads by their names (KN-09 Parents Why 351 → why351). */
export const IDEAS = {
  why351: { label: "Why ₹351, not free", hint: "Paid sign-up keeps casual browsers away; marriage isn't time-pass; less than ₹1 a day.", match: /why\s*₹?\s*351|time\s*-?pass|not\s*free/i },
  community: { label: "Your community", hint: "Matches within your own language and community; name the region's castes and sub-castes.", match: /communit|caste|samaj/i },
  daughters: { label: "For parents of daughters (safety)", hint: "Safety rules for brides' families: misusers removed for good, report any time, reviewed in 24 hours.", match: /safety|safe|daughter|women|bride/i },
  how_it_works: { label: "How it works", hint: "Three simple steps: register, set preferences, send interest. Answers 'is this real?'.", match: /how\s*it\s*works|steps|how\s*to/i },
  horoscope: { label: "Horoscope & gothra", hint: "Horoscope matching and gothra for the family's peace of mind.", match: /horoscope|kundli|kundali|jathak|jatak|gothra|gotra|astro/i },
  no_agents: { label: "No agents, no sales calls", hint: "Families talk directly; no brokers or agents, no sales calls.", match: /agent|broker|sales\s*call|no\s*spam/i },
  answer: { label: "Answer a family's doubt", hint: "Take one real question families ask and answer it plainly.", match: /faq|doubt|question|answer|is\s*it\s*real/i },
  festival: { label: "Festival / wedding season", hint: "The festival or wedding season coming up in the region, with a warm invite. Never print dates.", match: /festival|muhurt|season|sankranti|ugadi|diwali|deepavali|navrat|pongal|onam|dussehra/i },
  pricing: {
    label: "Every price, in the open",
    hint: "Show the real price list from the pricing page (membership and credits, extra credit packs, astrology reports). Few matrimony sites publish all their prices; ours are on one public page before you register, with no hidden charges and no sales calls.",
    match: /pricing|price\s*list|every\s*price|hidden\s*(charge|cost|fee)/i,
    // Posts with this idea link to the pricing page in their language (/kn/pricing).
    path: "/pricing",
  },
  brand: { label: "Who we are (brand)", hint: "A matrimony site for families, by language; the basics of what it is.", match: /brand|hero|about|trust/i },
};
export const IDEA_KEYS = Object.keys(IDEAS);
const BASE_KEYS = [...IDEA_KEYS];

/** Where an idea may be used: "organic", "ads" or "both" (built-in ideas: both). */
export const ideaTarget = (k) => IDEAS[k]?.target ?? "both";

/** The prices the pricing idea may state, from the live price level (never the struck-through price or referral discount). */
export const pricingFacts = (p) =>
  `Prices you may state (from the pricing page, seetharamakalyana.in/pricing): ${
    p.registrationFee ? `yearly membership ₹${p.registrationFee}` : "registration is free"
  } with ${p.registrationInterests} interest credits (1 credit = 1 interest); extra credits ₹${p.interestPacks.basic.amount} for ${p.interestPacks.basic.interests} or ₹${p.interestPacks.premium.amount} for ${p.interestPacks.premium.interests}; contact details are shared when the other family accepts your interest, or can be unlocked with credits; astrology reports ₹${p.astroFees.Overview} (overview), ₹${p.astroFees["Kundli Matching"]} (kundli matching), ₹${p.astroFees.Personalized} (personalised). Every price is on one public page before you register; no hidden charges.`;

let FACTS = "";
/** Extra allowed facts for writers and checkers: the live prices and the owner's own ideas. Call loadOwnerIdeas() first. */
export const ideaFacts = () => FACTS;

/**
 * Merges the owner's standing ideas (Ops → Plan an idea → "Keep in …") into
 * IDEAS / IDEA_KEYS in place, so every planner, schema and the idea library
 * treat them like the built-in ones, and refreshes the allowed facts.
 */
export const loadOwnerIdeas = async () => {
  const config = await getConfig();
  for (const k of Object.keys(IDEAS)) if (!BASE_KEYS.includes(k)) delete IDEAS[k];
  const owner = (config.ownerIdeas ?? []).filter((i) => i && i.key && i.active !== false);
  for (const i of owner) IDEAS[i.key] = { label: i.label, hint: i.hint, match: /(?!)/, target: i.target, owner: true, path: i.path || "" };
  IDEA_KEYS.splice(0, IDEA_KEYS.length, ...Object.keys(IDEAS));
  const prices = await getPricing().catch(() => null);
  FACTS = [
    prices ? pricingFacts(prices) : "",
    ...owner.filter((i) => i.facts).map((i) => `The owner's idea "${i.label}" — facts from the owner you may state: ${i.facts}`),
  ]
    .filter(Boolean)
    .join("\n");
  return owner;
};

/** "Parents 45-65" / "Young 24-34" / "Women ..." from an ad set name. */
export const audienceOf = (adsetName = "") => {
  if (/parent/i.test(adsetName)) return { key: "parents", label: "Parents (45–65) looking for a match for their son or daughter" };
  if (/young|self|single/i.test(adsetName)) return { key: "young", label: "Young professionals (24–34) looking for a partner for themselves" };
  if (/women|bride/i.test(adsetName)) return { key: "women", label: "Women and brides' families" };
  return { key: "all", label: "Families and young people looking for a match" };
};

/** The idea of one ad: the agent's own record first, else its name, else "other". */
export const ideaOf = (name = "", known) => known ?? IDEA_KEYS.find((k) => IDEAS[k].match.test(name)) ?? "other";

const cell = (lib, idea, language, audience) => lib.find((r) => r.idea === idea && r.language === language && r.audience === audience);
const cpp = (r) => (r?.paid ? r.spend / r.paid : Infinity);

/**
 * Adds up ads into idea × language × audience rows.
 * @param {{ ads: Array<{ id, name, campaignName, adsetName, spend, paid }>, ideaByAd?: Map<string, string> }} p
 */
export const buildLibrary = ({ ads, ideaByAd = new Map() }) => {
  const rows = new Map();
  for (const a of ads) {
    const idea = ideaOf(a.name, ideaByAd.get(a.id));
    const language = languageOf(a.campaignName ?? "");
    const audience = audienceOf(a.adsetName ?? "").key;
    const key = `${idea}|${language}|${audience}`;
    const r = rows.get(key) ?? { idea, language, audience, spend: 0, paid: 0, ads: [] };
    r.spend += a.spend || 0;
    r.paid += a.paid || 0;
    r.ads.push(a.name);
    rows.set(key, r);
  }
  return [...rows.values()].map((r) => ({ ...r, cpp: r.paid ? r.spend / r.paid : null }));
};

/** Enough spend to call an idea tested in one language and audience (₹), and members to call it proven. */
export const TESTED_SPEND = 1500;
export const PROVEN_PAID = 5;

/**
 * Picks the ideas for one ad set: the best proven idea and up to 3 test candidates.
 * @returns {{ proven: { idea, cpp, where } | null, tests: Array<{ idea, prior: number|null, why: string }> }}
 */
export const pickIdeas = ({ library, language, audience }) => {
  const here = (idea) => cell(library, idea, language, audience);
  const elsewhere = (idea) => {
    const rows = library.filter((r) => r.idea === idea && r.audience === audience && r.language !== language);
    const spend = rows.reduce((t, r) => t + r.spend, 0);
    const paid = rows.reduce((t, r) => t + r.paid, 0);
    return paid ? { cpp: spend / paid, paid } : null;
  };

  // Organic-only ideas never go into ads.
  const candidates = IDEA_KEYS.filter((k) => k !== "brand" && ideaTarget(k) !== "organic");
  const provenHere = candidates.filter((k) => (here(k)?.paid ?? 0) >= PROVEN_PAID).sort((a, b) => cpp(here(a)) - cpp(here(b)));
  let proven = provenHere[0] ? { idea: provenHere[0], cpp: cpp(here(provenHere[0])), where: "here" } : null;
  if (!proven) {
    const other = candidates.filter((k) => (elsewhere(k)?.paid ?? 0) >= PROVEN_PAID).sort((a, b) => elsewhere(a).cpp - elsewhere(b).cpp)[0];
    if (other) proven = { idea: other, cpp: elsewhere(other).cpp, where: "other languages" };
  }

  // Test: ideas not yet given a fair spend here, the ones that did best for this audience elsewhere first.
  const untested = candidates.filter((k) => k !== proven?.idea && (here(k)?.spend ?? 0) < TESTED_SPEND);
  const tests = untested
    .map((k) => {
      const e = elsewhere(k);
      return {
        idea: k,
        prior: e ? e.cpp : null,
        why: e ? `₹${Math.round(e.cpp)} per member for this audience in other languages` : "not tried anywhere yet",
      };
    })
    // The owner's own ideas are tested first, then the ones that did best elsewhere.
    .sort((a, b) => (IDEAS[b.idea]?.owner ? 1 : 0) - (IDEAS[a.idea]?.owner ? 1 : 0) || (a.prior ?? Infinity) - (b.prior ?? Infinity))
    .map((t) => (IDEAS[t.idea]?.owner ? { ...t, why: "your idea (Plan an idea)" } : t));
  // Nothing left untested: retry the second-best proven idea with a fresh take.
  if (!tests.length && provenHere[1]) tests.push({ idea: provenHere[1], prior: cpp(here(provenHere[1])), why: "second-best idea here; a fresh take" });
  return { proven, tests: tests.slice(0, 3) };
};

/**
 * One new ad's verdict against its ad set over the same days.
 * win: ≤ 90% of the ad set's cost per member · lose: ≥ 130%, or no members after enough spend · even: between.
 * Needs ₹1,500 of spend, or 14 days (then "unclear" if Meta barely delivered it).
 */
export const verdictFor = ({ ad, adset, ageDays }) => {
  if (ageDays < 7) return null;
  if (ad.spend < TESTED_SPEND) return ageDays >= 14 ? { verdict: "unclear", note: `Meta spent only ₹${Math.round(ad.spend)} on it in ${Math.round(ageDays)} days.` } : null;
  const ref = adset.paid ? adset.spend / adset.paid : null;
  const own = ad.paid ? ad.spend / ad.paid : Infinity;
  if (!ref) return { verdict: ad.paid ? "win" : "even", note: "Its ad set had no members to compare with." };
  const ratio = own / ref;
  const note = `₹${Number.isFinite(own) ? Math.round(own) : "∞"} per member vs ₹${Math.round(ref)} for its ad set.`;
  if (ratio <= 0.9) return { verdict: "win", note };
  if (ratio >= 1.3) return { verdict: "lose", note };
  return { verdict: "even", note };
};

/* ------------------------------ data loading ------------------------------ */

const since = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

/** The idea library from the last `days` days of ad snapshots. */
export const loadIdeaLibrary = async (days = 60) => {
  const [adRows, adsetRows, creatives] = await Promise.all([
    AdSnapshot.aggregate([
      { $match: { level: "ad", date: { $gte: since(days) } } },
      { $group: { _id: "$entityId", name: { $last: "$name" }, campaignName: { $last: "$campaignName" }, adsetId: { $last: "$adsetId" }, spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
    ]),
    AdSnapshot.aggregate([{ $match: { level: "adset" } }, { $sort: { date: -1 } }, { $group: { _id: "$entityId", name: { $first: "$name" } } }]),
    OpsCreative.find({ adId: { $ne: null }, idea: { $ne: null } }).select("adId idea").lean(),
  ]);
  const adsetName = new Map(adsetRows.map((r) => [r._id, r.name]));
  return buildLibrary({
    ads: adRows.map((r) => ({ id: r._id, name: r.name, campaignName: r.campaignName, adsetName: adsetName.get(r.adsetId) ?? "", spend: r.spend, paid: r.paid })),
    ideaByAd: new Map(creatives.map((c) => [c.adId, c.idea])),
  });
};

/** What families are asking or doubting (last 14 days), without names or contact details. */
export const familyDoubts = async () => {
  const from = new Date(Date.now() - 14 * DAY);
  const [comments, mails] = await Promise.all([
    OpsComment.find({ createdAt: { $gte: from }, category: { $in: ["question", "hate"] } }).select("text").sort({ createdAt: -1 }).limit(25).lean(),
    OpsMail.find({ receivedAt: { $gte: from }, category: { $in: ["question", "complaint", "verification", "refund"] }, summary: { $ne: null } }).select("summary category").sort({ receivedAt: -1 }).limit(15).lean(),
  ]);
  const scrub = (s) => String(s || "").replace(/\S+@\S+/g, "[email]").replace(/\+?\d[\d\s-]{8,}\d/g, "[number]").replace(/\s+/g, " ").trim().slice(0, 160);
  return [...comments.map((c) => `comment: ${scrub(c.text)}`), ...mails.map((m) => `${m.category} mail: ${scrub(m.summary)}`)].filter((l) => l.length > 12);
};

/** Brides' share of new members (last 14 days). */
export const bridesShare = async () => {
  const rows = await User.aggregate([
    { $match: { createdAt: { $gte: new Date(Date.now() - 14 * DAY) } } },
    { $group: { _id: "$basic.gender", n: { $sum: 1 } } },
  ]);
  const total = rows.reduce((t, r) => t + r.n, 0);
  const women = rows.find((r) => r._id === "Female")?.n ?? 0;
  return total ? { women, total, share: women / total } : null;
};

/** Messages of organic posts that brought sign-ups (message only; posts are never turned into ads). */
export const organicWinners = async () => {
  const report = await OpsReport.findOne({ kind: "organic" }).sort({ createdAt: -1 }).lean();
  return (report?.data?.posts ?? [])
    .filter((p) => (p.signups ?? 0) > 0)
    .sort((a, b) => b.signups - a.signups)
    .slice(0, 3)
    .map((p) => `${p.signups} sign-ups: "${String(p.text).replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").slice(0, 140)}"`);
};

/**
 * Judges the agent's new ads that have run long enough. Returns the ones
 * judged now (each also lands in the Ops feed).
 */
export const judgeNewAds = async () => {
  const live = await OpsCreative.find({ status: "live", adId: { $ne: null }, verdict: null }).lean();
  const judged = [];
  for (const c of live) {
    const start = c.liveAt ?? c.updatedAt;
    const ageDays = (Date.now() - new Date(start).getTime()) / DAY;
    if (ageDays < 7) continue;
    const from = new Date(start).toISOString().slice(0, 10);
    const sum = async (level, entityId) =>
      (
        await AdSnapshot.aggregate([
          { $match: { level, entityId, date: { $gte: from } } },
          { $group: { _id: null, spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
        ])
      )[0] ?? { spend: 0, paid: 0 };
    const [ad, adset] = await Promise.all([sum("ad", c.adId), sum("adset", c.adsetId)]);
    const v = verdictFor({ ad, adset, ageDays });
    if (!v) continue;
    await OpsCreative.updateOne(
      { _id: c._id },
      { $set: { verdict: v.verdict, verdictAt: new Date(), results: { spend: ad.spend, paid: ad.paid, adsetSpend: adset.spend, adsetPaid: adset.paid, note: v.note } } }
    );
    judged.push({ creative: c, ...v });
  }
  return judged;
};
