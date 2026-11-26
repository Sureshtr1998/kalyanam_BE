import Anthropic from "@anthropic-ai/sdk";
import { OpsUsage, getConfig } from "./models.js";

/*
 * The only place the ops agent talks to Claude. Each task names a tier;
 * the tier decides the model and effort, so costs stay predictable:
 *  - sort:   Haiku 5.5 — triage, language detection, short replies
 *  - write:  Sonnet 5.5 — sensitive replies, posts, daily ads notes
 *  - think:  Opus 5.5 — weekly review, change-day plans
 */

const TIERS = {
  sort: { model: "claude-haiku-5-5", effort: "low", inUsd: 0.1, outUsd: 0.5 },
  write: { model: "claude-sonnet-5-5", effort: "medium", inUsd: 2, outUsd: 10 },
  think: { model: "claude-opus-5-5", effort: "high", inUsd: 4, outUsd: 20 },
};

let client;
const getClient = () => {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 45000 });
  return client;
};

export const claudeConfigured = () => !!process.env.ANTHROPIC_API_KEY;

export class ClaudeUnavailable extends Error {}

/** Claude spend so far this calendar month (USD). */
export const monthSpendUsd = async () => {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const [row] = await OpsUsage.aggregate([{ $match: { at: { $gte: start } } }, { $group: { _id: null, usd: { $sum: "$usd" } } }]);
  return row?.usd ?? 0;
};

const costOf = (tier, usage) => {
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  return (
    ((fresh + written * 1.25 + cached * 0.1) * tier.inUsd + (usage.output_tokens ?? 0) * tier.outUsd) / 1e6
  );
};

/**
 * Asks Claude and returns parsed JSON matching `schema` (or plain text when
 * no schema is given). The stable `system` text is cached between calls.
 */
export const ask = async ({ task, tier = "sort", system, prompt, schema, maxTokens = 2000 }) => {
  const api = getClient();
  if (!api) throw new ClaudeUnavailable("ANTHROPIC_API_KEY is not set");

  const config = await getConfig();
  if ((await monthSpendUsd()) >= config.limits.claudeMonthlyUsd) {
    throw new ClaudeUnavailable("This month's Claude budget is used up (Ops → Settings)");
  }

  const t = TIERS[tier];
  /** @type {any} */
  const request = {
    model: t.model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: t.effort, ...(schema ? { format: { type: "json_schema", schema } } : {}) },
  };
  const res = await api.messages.create(request);

  await OpsUsage.create({
    task,
    model: t.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    usd: costOf(t, res.usage),
  }).catch(() => {});

  if (res.stop_reason === "refusal") throw new Error("Claude declined this request");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!schema) return text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Claude returned something that isn't JSON");
  }
};

/** All-time spend and this month's spend by task (USD). */
export const spendSummary = async () => {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const [total, byTask] = await Promise.all([
    OpsUsage.aggregate([{ $group: { _id: null, usd: { $sum: "$usd" }, calls: { $sum: 1 } } }]),
    OpsUsage.aggregate([{ $match: { at: { $gte: start } } }, { $group: { _id: "$task", usd: { $sum: "$usd" }, calls: { $sum: 1 } } }, { $sort: { usd: -1 } }]),
  ]);
  return {
    totalUsd: total[0]?.usd ?? 0,
    totalCalls: total[0]?.calls ?? 0,
    monthUsd: byTask.reduce((t, r) => t + r.usd, 0),
    byTask: byTask.map((r) => ({ task: r._id, usd: r.usd, calls: r.calls })),
  };
};

/**
 * USD → INR, refreshed once a day from a free public rate feed
 * (open.er-api.com); falls back to the last known rate, then 88.
 */
export const inrRate = async () => {
  const config = await getConfig();
  const fx = config.lastRuns?.fx;
  if (fx?.rate && Date.now() - new Date(fx.at).getTime() < 86400000) return fx.rate;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(5000) });
    const rate = (await res.json())?.rates?.INR;
    if (rate > 50 && rate < 200) {
      config.lastRuns = { ...(config.lastRuns ?? {}), fx: { rate, at: new Date() } };
      config.markModified("lastRuns");
      await config.save();
      return rate;
    }
  } catch {
    /* offline: use the last rate */
  }
  return fx?.rate ?? 88;
};
