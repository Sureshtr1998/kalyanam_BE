import { AdSnapshot, OpsAction, OpsPost, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { execute, propose } from "./actions.js";
import { THEME_NAMES } from "./postDesign.js";
import { igConfigured } from "./meta.js";
import { requestRenders } from "./organic.js";
import { CLAIM_RULES, proposeIdeaCreatives } from "./adsCreative.js";
import { proposeIdeaAdset } from "./adsGrowth.js";

/*
 * "Plan an idea": the owner (or the weekly review) writes an idea in plain
 * words; Claude turns it into steps the agent can carry out, and each step
 * is scheduled with the usual notice and limits:
 *   organic_post  → a designed post on a date (never boosted)
 *   ad_creatives  → new ads in a language campaign (nothing paused)
 *   new_adset     → a new ad set copied from an existing one
 *   budget        → a campaign or ad set budget change
 *   unsupported   → a "needs you" card saying what's missing
 * Weekly-review ideas nobody acts on for 48 hours are planned the same way.
 */

const STEP = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "date", "summary", "language", "post", "ad", "adset", "budget"],
  properties: {
    kind: { type: "string", enum: ["organic_post", "ad_creatives", "new_adset", "budget", "unsupported"] },
    date: { type: "string", description: "YYYY-MM-DD (IST) when it should happen; today or later" },
    summary: { type: "string", description: "One line for the calendar, English" },
    language: { type: "string", description: "Kannada, Telugu, Tamil, Hindi or English" },
    post: {
      type: "object",
      additionalProperties: false,
      required: ["topic", "kicker", "headline", "subline", "theme", "caption"],
      description: "organic_post only (empty strings otherwise)",
      properties: {
        topic: { type: "string" },
        kicker: { type: "string", description: "2–4 words on the image, in the language's script" },
        headline: { type: "string", description: "Max 9 words, in the language's script" },
        subline: { type: "string", description: "Max 12 words, same language" },
        theme: { type: "string", enum: [...THEME_NAMES, ""] },
        caption: { type: "string", description: "Under 120 words, same script, 3–6 hashtags, ends with seetharamakalyana.in" },
      },
    },
    ad: {
      type: "object",
      additionalProperties: false,
      required: ["campaignId", "adsetId", "variants"],
      description: "ad_creatives only",
      properties: {
        campaignId: { type: "string" },
        adsetId: { type: "string", description: "Ad set to add them to, or empty for the campaign's best one" },
        variants: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kicker", "headline", "highlight", "bullets", "price", "cta", "primaryText", "title", "translation"],
            properties: {
              kicker: { type: "string", description: "Pill on the image, max 6 words" },
              headline: { type: "string", description: "Headline line 1, max 5 words" },
              highlight: { type: "string", description: "Headline line 2 (the punchline), max 5 words" },
              bullets: { type: "array", items: { type: "string" }, description: "Exactly 3 ticks, max 7 words each" },
              price: { type: "string", description: "Price line, e.g. '₹351 a year'" },
              cta: { type: "string", description: "Button text, max 4 words" },
              primaryText: { type: "string", description: "Max 220 characters" },
              title: { type: "string", description: "Max 40 characters" },
              translation: { type: "string", description: "English translation of every line, for the owner" },
            },
          },
        },
      },
    },
    adset: {
      type: "object",
      additionalProperties: false,
      required: ["campaignId", "baseAdsetId", "name", "locations", "ageMin", "ageMax", "gender", "dailyBudget"],
      description: "new_adset only",
      properties: {
        campaignId: { type: "string" },
        baseAdsetId: { type: "string" },
        name: { type: "string", description: "Language | Place | Audience" },
        locations: { type: "array", items: { type: "string" } },
        ageMin: { type: "integer" },
        ageMax: { type: "integer" },
        gender: { type: "string", enum: ["all", "men", "women"] },
        dailyBudget: { type: "integer" },
      },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      required: ["entityId", "dailyBudget"],
      description: "budget only",
      properties: { entityId: { type: "string" }, dailyBudget: { type: "integer", description: "New ₹ per day" } },
    },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "steps"],
  properties: {
    title: { type: "string", description: "Short name for the idea, English" },
    steps: { type: "array", items: STEP },
  },
};

const ist = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600000);
const todayIst = () => ist().toISOString().slice(0, 10);
/** A wall-clock IST time on a YYYY-MM-DD date, as a real Date. */
const atIst = (date, hh, mm = 0) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm) - 5.5 * 3600000);

/** What the planner may touch: the account's current campaigns and ad sets. */
const accountShape = async () => {
  const latest = await AdSnapshot.findOne({ level: "campaign" }).sort({ date: -1 }).lean();
  if (!latest) return { campaigns: [], adsets: [] };
  const rows = await AdSnapshot.find({ date: latest.date, level: { $in: ["campaign", "adset"] } }).lean();
  return {
    campaigns: rows.filter((r) => r.level === "campaign").map((r) => ({ id: r.entityId, name: r.name, dailyBudget: r.dailyBudget ?? null, status: r.status })),
    adsets: rows.filter((r) => r.level === "adset").map((r) => ({ id: r.entityId, name: r.name, campaignId: r.campaignId, dailyBudget: r.dailyBudget ?? null, status: r.status })),
  };
};

/**
 * Plans an idea and schedules its steps.
 * @returns {{ ideaId: string, title: string, steps: Array<{ kind, summary, date, status, error? }> }}
 */
export const planIdea = async ({ text, by = "admin", source = "owner" }) => {
  const idea = String(text || "").trim();
  if (idea.length < 8) throw Object.assign(new Error("Describe the idea in a sentence or two"), { status: 400 });
  const config = await getConfig();
  const shape = await accountShape();
  const upcoming = await OpsPost.find({ publishAt: { $gte: new Date() }, status: { $ne: "cancelled" } }).select("publishAt language topic").lean();

  const plan = await ask({
    task: "ideas.plan",
    tier: "ads",
    system: `You turn the owner's ideas into concrete, schedulable steps for Seetha Rama Kalyana's marketing agent.
${config.brief}
Rules:
- Only these step kinds exist: organic_post, ad_creatives, new_adset, budget. Anything else (videos, reels, WhatsApp broadcasts, offline events, website changes, price changes, boosting organic posts) is an "unsupported" step whose summary says exactly what the owner must do.
- Organic posts are never ads. One post per day per date at most; avoid days already taken.
- Ads only inside the existing campaigns and ad sets listed (use their ids). One campaign per language; a new ad set follows the naming of the existing ad sets in its campaign.
- Owner's standing rules for ads:
${config.ads?.preferences ?? ""}
${CLAIM_RULES}
- Write post and ad text in the target language's native script (English only for English), warm and natural, never a literal translation. No competitor names, no promises beyond the brief, no fake urgency.
- Budgets in ₹/day. The whole account must stay under ₹${config.limits.maxDailySpend}/day.
- Dates: today is ${todayIst()} (IST). Use the dates the idea implies; otherwise the next sensible days. Fill fields of other step kinds with empty values.`,
    prompt: `Idea (from ${source === "owner" ? "the owner" : "the weekly review"}): """${idea.slice(0, 2000)}"""

Campaigns: ${shape.campaigns.map((c) => `${c.name} [${c.id}]${c.dailyBudget ? ` ₹${c.dailyBudget}/day` : ""}${c.status && c.status !== "ACTIVE" ? ` (${c.status})` : ""}`).join("; ") || "none yet"}
Ad sets: ${shape.adsets.map((a) => `${a.name} [${a.id}] in ${a.campaignId}${a.dailyBudget ? ` ₹${a.dailyBudget}/day` : ""}`).join("; ") || "none yet"}
Days already with an organic post: ${[...new Set(upcoming.map((p) => ist(p.publishAt).toISOString().slice(0, 10)))].join(", ") || "none"}`,
    schema: SCHEMA,
    maxTokens: 16000,
  });

  const ideaDoc = await OpsAction.create({
    module: "ads",
    type: "ops.idea",
    status: "done",
    title: `Idea: ${plan.title || idea.slice(0, 80)}`,
    reason: idea.slice(0, 1000),
    effect: `${plan.steps.length} step(s) planned`,
    decidedBy: by,
    ranAt: new Date(),
    payload: { source },
  });
  const ideaId = String(ideaDoc._id);
  const noticeAt = new Date(Date.now() + config.limits.adNoticeHours * 3600000);
  const results = [];

  for (const s of plan.steps.slice(0, 15)) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.date >= todayIst() ? s.date : todayIst();
    const reason = `From the idea "${plan.title || idea.slice(0, 60)}". ${s.summary}`;
    const row = { kind: s.kind, summary: s.summary, date };
    try {
      if (s.kind === "organic_post") {
        if (config.modes.organic === "off") throw new Error("Organic posts are Off in Settings");
        let publishAt = atIst(date, 19, 30);
        if (publishAt < new Date(Date.now() + 2 * 3600000)) publishAt = atIst(ist(new Date(Date.now() + 86400000)).toISOString().slice(0, 10), 19, 30);
        const post = await OpsPost.create({
          publishAt,
          language: s.language || "English",
          topic: s.post.topic || s.summary,
          caption: s.post.caption,
          design: { kicker: s.post.kicker, headline: s.post.headline || s.summary, subline: s.post.subline, theme: s.post.theme || "saffron" },
          platforms: igConfigured() ? ["facebook", "instagram"] : ["facebook"],
          status: "design",
        });
        row.status = "planned";
        row.ref = String(post._id);
      } else if (s.kind === "ad_creatives") {
        const c = shape.campaigns.find((x) => x.id === s.ad.campaignId);
        if (!c) throw new Error("That campaign doesn't exist");
        if (!s.ad.variants?.length) throw new Error("No ad copy was written");
        const runAt = new Date(Math.max(noticeAt.getTime(), atIst(date, 6).getTime()));
        const a = await proposeIdeaCreatives({ campaignId: c.id, campaignName: c.name, adsetId: s.ad.adsetId, language: s.language, variants: s.ad.variants, runAt, reason, ideaId });
        row.status = a?.status ?? "skipped (Ads is Off)";
      } else if (s.kind === "new_adset") {
        const runAt = new Date(Math.max(noticeAt.getTime(), atIst(date, 6).getTime()));
        const a = await proposeIdeaAdset(s.adset, { runAt, reason, ideaId });
        row.status = a?.status ?? "skipped (Ads is Off)";
      } else if (s.kind === "budget") {
        const e = [...shape.campaigns, ...shape.adsets].find((x) => x.id === s.budget.entityId);
        if (!e?.dailyBudget) throw new Error("That campaign or ad set has no budget of its own");
        const to = Math.round(s.budget.dailyBudget / 10) * 10;
        const total = [...shape.campaigns, ...shape.adsets].reduce((t, x) => t + (x.dailyBudget || 0), 0);
        if (to < 100) throw new Error("Budget would be below ₹100/day");
        if (total - e.dailyBudget + to > config.limits.maxDailySpend) throw new Error(`Would pass the ₹${config.limits.maxDailySpend}/day limit`);
        const big = Math.abs(to - e.dailyBudget) / e.dailyBudget > 0.2;
        const a = await propose("ads", {
          type: "ads.budget",
          title: `${e.name}: ₹${e.dailyBudget} → ₹${to}/day`,
          reason,
          effect: `Daily budget ₹${e.dailyBudget} → ₹${to}.${big ? " A change over 20% restarts Meta's learning for ~3 days." : ""}`,
          payload: { entityId: e.id, from: e.dailyBudget, to, ideaId },
          ref: { kind: "meta", id: `idea-budget:${ideaId}:${e.id}` },
          runAt: new Date(Math.max(noticeAt.getTime(), atIst(date, 6).getTime())),
        });
        row.status = a?.status ?? "skipped (Ads is Off)";
      } else {
        throw new Error(s.summary || "The agent can't do this part");
      }
    } catch (err) {
      row.status = "needs_you";
      row.error = err.message;
      await OpsAction.create({
        module: s.kind === "organic_post" ? "organic" : "ads",
        type: "ops.note",
        status: "needs_you",
        title: `Idea step needs you: ${s.summary}`.slice(0, 200),
        reason: `${reason} ${err.message}`,
        effect: "The agent can't do this part. Do it yourself, or cancel this card.",
        runAt: atIst(date, 9),
        payload: { ideaId },
      });
    }
    results.push(row);
  }
  if (results.some((r) => r.kind === "organic_post" && r.status === "planned")) await requestRenders().catch(() => {});
  ideaDoc.result = { steps: results };
  ideaDoc.effect = `${results.filter((r) => r.status !== "needs_you").length} of ${results.length} step(s) scheduled`;
  await ideaDoc.save();
  return { ideaId, title: plan.title, steps: results };
};

/**
 * Weekly-review and SEO ideas nobody scheduled or cancelled within 48 hours:
 * SEO ideas start their developer request; the rest are planned like an
 * owner's idea. One per run, so a tick stays short.
 */
export const autoPlanIdeas = async () => {
  const cutoff = new Date(Date.now() - 48 * 3600000);
  const old = await OpsAction.findOne({ status: "idea", createdAt: { $lte: cutoff } }).sort({ createdAt: 1 });
  if (!old) return { planned: 0 };
  if (old.type === "dev.request") {
    old.status = "scheduled";
    old.runAt = new Date();
    old.decidedBy = "agent (no answer in 48 h)";
    await old.save();
    await execute(old._id, "agent (no answer in 48 h)");
    return { started: String(old._id) };
  }
  const r = await planIdea({ text: `${old.title}. ${old.reason}`, by: "agent (no answer in 48 h)", source: "review" });
  old.status = "done";
  old.ranAt = new Date();
  old.decidedBy = "agent (no answer in 48 h)";
  old.result = { plannedAs: r.ideaId, steps: r.steps.length };
  await old.save();
  return { planned: r.steps.length, ideaId: r.ideaId };
};
