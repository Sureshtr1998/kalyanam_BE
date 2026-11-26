import User from "../models/User.js";
import Broker from "../models/Broker.js";
import { AdSnapshot, OpsAction, OpsComment, OpsMail, OpsPost, OpsReport, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { handle, propose } from "./actions.js";
import { unitStates } from "./ads.js";
import { toolsOverview } from "./tools.js";

/*
 * Growth (expected vs actual) and the weekly business review.
 * The review is the agent's long-term memory: each one reads the previous
 * review and the decision log, so nothing needs a long chat history.
 */

const TZ = "Asia/Kolkata";
const monthKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }).slice(0, 7);

/** Members, revenue and ad spend per month for the last 12 months. */
export const monthlyActuals = async () => {
  const since = new Date(Date.now() - 370 * 86400000);
  const month = (f) => ({ $dateToString: { format: "%Y-%m", date: f, timezone: TZ } });
  const NET = {
    $subtract: [
      { $ifNull: ["$transactions.amountPaid", 0] },
      { $add: [{ $ifNull: ["$transactions.amountRefunded", 0] }, { $ifNull: ["$transactions.referralRefunded", 0] }] },
    ],
  };
  const earn = [{ $unwind: "$transactions" }, { $match: { "transactions.dateOfTrans": { $gte: since } } }, { $group: { _id: month("$transactions.dateOfTrans"), v: { $sum: NET } } }];
  const [joins, e1, e2, spend] = await Promise.all([
    User.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: month("$createdAt"), v: { $sum: 1 } } }]),
    User.aggregate(earn),
    Broker.aggregate(earn),
    AdSnapshot.aggregate([{ $match: { level: "account" } }, { $group: { _id: { $substrCP: ["$date", 0, 7] }, v: { $sum: "$spend" } } }]),
  ]);
  const m = new Map();
  const add = (rows, k) => rows.forEach((r) => m.set(r._id, { ...(m.get(r._id) ?? { members: 0, revenue: 0, spend: 0 }), [k]: (m.get(r._id)?.[k] ?? 0) + r.v }));
  add(joins, "members");
  add(e1, "revenue");
  add(e2, "revenue");
  add(spend, "spend");
  return m;
};

/** Expected vs actual for this month, quarter and year, with a run-rate projection. */
export const growth = async () => {
  const config = await getConfig();
  const actual = await monthlyActuals();
  const now = new Date();
  const thisMonth = monthKey(now);
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const daysIn = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOf = ist.getUTCDate();
  const target = (k) => config.targets.find((t) => t.month === k) ?? {};

  const months = [];
  for (let i = 11; i >= -2; i--) {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - i, 1));
    const k = d.toISOString().slice(0, 7);
    const a = actual.get(k) ?? { members: 0, revenue: 0, spend: 0 };
    const t = target(k);
    const running = k === thisMonth;
    months.push({
      month: k,
      actual: i >= 0 ? a : null,
      projected: running ? { members: Math.round((a.members / dayOf) * daysIn), revenue: Math.round((a.revenue / dayOf) * daysIn), spend: Math.round((a.spend / dayOf) * daysIn) } : null,
      target: { members: t.members ?? null, revenue: t.revenue ?? null, spend: t.spend ?? null },
    });
  }

  const sumOf = (keys) =>
    keys.reduce(
      (t, k) => {
        const row = months.find((x) => x.month === k);
        const a = row?.projected ?? row?.actual ?? { members: 0, revenue: 0, spend: 0 };
        const g = row?.target ?? {};
        return {
          members: t.members + a.members,
          revenue: t.revenue + a.revenue,
          spend: t.spend + a.spend,
          targetMembers: t.targetMembers + (g.members ?? 0),
          targetRevenue: t.targetRevenue + (g.revenue ?? 0),
        };
      },
      { members: 0, revenue: 0, spend: 0, targetMembers: 0, targetRevenue: 0 }
    );
  const y = ist.getUTCFullYear();
  const q = Math.floor(ist.getUTCMonth() / 3);
  const quarterKeys = [0, 1, 2].map((i) => `${y}-${String(q * 3 + i + 1).padStart(2, "0")}`).filter((k) => k <= thisMonth);
  const yearKeys = Array.from({ length: ist.getUTCMonth() + 1 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
  return { months, quarter: { label: `Q${q + 1} ${y}`, ...sumOf(quarterKeys) }, year: { label: String(y), ...sumOf(yearKeys) } };
};

const IDEAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["review", "nextSteps"],
  properties: {
    review: { type: "string", description: "Markdown, under 350 words: verdict per area (ads, organic, support, tools, SEO), what changed vs last week, risks" },
    nextSteps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["module", "title", "reason", "when"],
        properties: {
          module: { type: "string", enum: ["ads", "organic", "support", "comments", "seo", "dev", "tools"] },
          title: { type: "string" },
          reason: { type: "string" },
          when: { type: "string", description: "Suggested date YYYY-MM-DD" },
        },
      },
    },
  },
};

export const runWeeklyReview = async () => {
  const config = await getConfig();
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const [days, states, last, decided, mail, comments, posts, tools, seo, g] = await Promise.all([
    AdSnapshot.find({ level: "account", date: { $gte: since } }).sort({ date: 1 }).lean(),
    unitStates().catch(() => []),
    OpsReport.findOne({ kind: "weekly" }).sort({ createdAt: -1 }).lean(),
    OpsAction.find({ updatedAt: { $gte: new Date(Date.now() - 7 * 86400000) }, status: { $in: ["done", "cancelled", "failed", "shadow"] } }).select("module type status title").lean(),
    OpsMail.aggregate([{ $match: { createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } } }, { $group: { _id: "$category", n: { $sum: 1 } } }]),
    OpsComment.aggregate([{ $match: { createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } } }, { $group: { _id: "$category", n: { $sum: 1 } } }]),
    OpsPost.find({ publishAt: { $gte: new Date(Date.now() - 7 * 86400000), $lte: new Date() } }).select("topic language status").lean(),
    toolsOverview(),
    OpsReport.findOne({ kind: "seo" }).sort({ createdAt: -1 }).lean(),
    growth(),
  ]);

  const out = await ask({
    task: "review.weekly",
    tier: "think",
    system: `You are the business partner running Seetha Rama Kalyana's operations: Meta ads, organic social, support, tools and SEO.
${config.brief}
Standing rules: ad changes are batched every 2–3 weeks then hands off for 7 days; budget steps are at most ±${config.limits.stepUpPct}–${config.limits.stepDownPct}% a week; organic posts are never boosted; refunds are always the owner's decision; one Meta campaign per language with places as ad sets.
Write plainly for a busy owner reading on a phone. Next steps must be concrete and schedulable.`,
    prompt: `Last review (your memory):
${last?.body ?? "None — this is the first review."}

Daily account numbers, last 14 days (spend ₹ / Meta paid / real joins / earned ₹). Prepaid funds are the owner's job and never a reason for an ad change:
${days.map((d) => `${d.date}: ${Math.round(d.spend)} / ${d.paid} / ${d.joined ?? "-"} / ${Math.round(d.earned ?? 0)}`).join("\n")}

Ad units now: ${states.map((s) => `${s.name}: ${s.state} (₹${s.dailyBudget}/day, 7d cost/member ₹${Number.isFinite(s.metrics.cpp7) ? Math.round(s.metrics.cpp7) : "∞"}, ${s.metrics.roas7.toFixed(2)}x) ${s.notes.join(" ")}`).join("\n") || "no data yet"}

Agent actions this week: ${decided.map((a) => `[${a.module}/${a.status}] ${a.title}`).join("; ") || "none"}
Support mail by type: ${mail.map((m) => `${m._id} ${m.n}`).join(", ") || "none"}
Comments by type: ${comments.map((c) => `${c._id} ${c.n}`).join(", ") || "none"}
Organic posts published: ${posts.map((p) => `${p.topic} (${p.language}, ${p.status})`).join("; ") || "none"}
Tools needing attention: ${tools.filter((t) => ["upgrade", "watch", "error"].includes(t.status)).map((t) => `${t.name} ${t.status}${t.pct != null ? ` ${t.pct}%` : ""}`).join("; ") || "none"}
SEO (28 days): ${seo ? `${seo.data.total.clicks} clicks, ${seo.data.total.impressions} impressions` : "not connected"}
This month so far vs target: ${JSON.stringify(g.months.find((m) => m.projected))}
Quarter: ${JSON.stringify(g.quarter)}

Write the review and up to 5 next steps.`,
    schema: IDEAS_SCHEMA,
    maxTokens: 6000,
  });

  const period = new Date().toISOString().slice(0, 10);
  await OpsReport.create({ kind: "weekly", period, body: out.review, data: { nextSteps: out.nextSteps } });
  for (const s of out.nextSteps.slice(0, 5)) {
    await propose(s.module, {
      type: "ops.note",
      status: "idea",
      title: s.title,
      reason: s.reason,
      effect: "A suggestion. Schedule it to put it on the calendar, or cancel it.",
      runAt: new Date(`${s.when}T04:00:00Z`),
      payload: { dedupeKey: `idea:${s.title.toLowerCase().slice(0, 60)}` },
    });
  }
  return { period, nextSteps: out.nextSteps.length };
};

// Ideas carry no automatic work; running one records that it was done.
handle("ops.note", async () => ({ recorded: true }));
