import jwt from "jsonwebtoken";
import { OpsReport, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { propose } from "./actions.js";

/*
 * Google Search Console (read only). Uses a Google Cloud service account
 * (GSC_SERVICE_ACCOUNT_JSON) that has been added as a user on the property.
 * Weekly: clicks/impressions by day, top queries and pages, and a few
 * concrete SEO ideas that land in the Ops feed as "ideas".
 */

export const seoConfigured = () => !!process.env.GSC_SERVICE_ACCOUNT_JSON;
const SITE = () => process.env.GSC_SITE || "sc-domain:seetharamakalyana.in";

let cached = { token: null, exp: 0 };
const accessToken = async () => {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const sa = JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: "RS256" }
  );
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${body.error_description || body.error}`);
  cached = { token: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return cached.token;
};

const query = async (body) => {
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE())}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Search Console: ${data.error?.message || res.status}`);
  return data.rows ?? [];
};

const ymd = (d) => d.toISOString().slice(0, 10);

/** Last 28 days (Search Console data lags ~3 days), compared with the 28 before. */
export const fetchSeo = async () => {
  const end = new Date(Date.now() - 3 * 86400000);
  const start = new Date(end.getTime() - 27 * 86400000);
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - 27 * 86400000);
  const range = { startDate: ymd(start), endDate: ymd(end) };
  const [byDay, queries, pages, prev] = await Promise.all([
    query({ ...range, dimensions: ["date"] }),
    query({ ...range, dimensions: ["query"], rowLimit: 25 }),
    query({ ...range, dimensions: ["page"], rowLimit: 15 }),
    query({ startDate: ymd(prevStart), endDate: ymd(prevEnd) }),
  ]);
  const total = byDay.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions }), { clicks: 0, impressions: 0 });
  const row = (r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
  return {
    range,
    total,
    previous: { clicks: prev[0]?.clicks ?? 0, impressions: prev[0]?.impressions ?? 0 },
    days: byDay.map((r) => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions })),
    queries: queries.map(row),
    pages: pages.map(row),
  };
};

export const runSeoWeekly = async () => {
  const config = await getConfig();
  const data = await fetchSeo();
  const { ideas } = await ask({
    task: "seo.weekly",
    tier: "write",
    system: `You are the SEO lead for seetharamakalyana.in, a matrimony site for Kannada, Telugu, Tamil and Hindi families.
${config.brief}
Suggest only honest, concrete changes (titles, descriptions, internal links, content for queries with impressions but low clicks). Never suggest fake reviews or claims.`,
    prompt: `Search Console, ${data.range.startDate} to ${data.range.endDate}:
Clicks ${data.total.clicks} (previous 28 days ${data.previous.clicks}), impressions ${data.total.impressions} (previous ${data.previous.impressions}).
Top queries: ${data.queries.map((q) => `${q.key} — ${q.clicks} clicks, ${q.impressions} impr, pos ${q.position.toFixed(1)}`).join("; ")}
Top pages: ${data.pages.map((p) => `${p.key} — ${p.clicks}/${p.impressions}`).join("; ")}
Give up to 3 ideas for this week.`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ideas"],
      properties: {
        ideas: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "reason", "change"],
            properties: { title: { type: "string" }, reason: { type: "string" }, change: { type: "string" } },
          },
        },
      },
    },
    maxTokens: 1500,
  });
  await OpsReport.create({ kind: "seo", period: `${data.range.startDate}..${data.range.endDate}`, data });
  for (const i of ideas.slice(0, 3)) {
    await propose("seo", {
      type: "dev.request",
      status: "idea",
      title: i.title,
      reason: i.reason,
      effect: `If you schedule it, the Developer agent makes this change on a branch for you to preview: ${i.change}`,
      payload: { repo: "fe", mode: "write", request: `${i.title}. ${i.change}` },
    });
  }
  return { clicks: data.total.clicks, ideas: ideas.length };
};
