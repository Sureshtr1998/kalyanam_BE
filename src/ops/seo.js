import jwt from "jsonwebtoken";
import { OpsReport, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { Defer, handle, notice, propose } from "./actions.js";
import { OpsAction } from "./models.js";
import { agentBranch, deploy, devConfigured, gh, previewFor, repoPath } from "./dev.js";

/*
 * Google Search Console (read only). Uses a Google Cloud service account
 * (GSC_SERVICE_ACCOUNT_JSON) that has been added as a user on the property.
 * Weekly: clicks/impressions by day, top queries and pages. When a change
 * is worth it, the agent schedules it itself and it deploys by itself, but
 * only ever inside the blogs (owner's hard rule, 28 Nov 2026): every changed
 * file must be under src/screens/blogs/ or the change is refused and closed.
 */

/** The only folder the SEO agent may change (website repo). */
export const BLOG_DIR = "src/screens/blogs/";
/** True when every changed file (and a renamed file's old path) is inside the blogs. */
export const blogOnly = (files) =>
  files.length > 0 && files.every((f) => f.filename?.startsWith(BLOG_DIR) && (!f.previous_filename || f.previous_filename.startsWith(BLOG_DIR)));

const SEO_RULE = `HARD RULE: change files under ${BLOG_DIR} only (blog posts, their titles, descriptions, FAQs, internal links between posts, new posts in blogsContents.tsx and the post files). Do not touch any other file, not even package files, routes, the sitemap or shared components; new posts are picked up by the build automatically. If the change can't be made inside ${BLOG_DIR}, change nothing and say so. Keep every claim honest: no fake reviews, numbers or promises. Run npm run build before you finish.`;
const GIVE_UP_MS = 3 * 86400000;

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

/** An SEO change still on its way (being written, waiting to deploy). */
const seoOpen = () =>
  OpsAction.findOne({ module: "seo", type: { $in: ["dev.request", "seo.deploy"] }, status: { $in: ["scheduled", "running", "shadow", "needs_you"] } }).lean();

export const runSeoWeekly = async () => {
  const config = await getConfig();
  const data = await fetchSeo();
  await OpsReport.create({ kind: "seo", period: `${data.range.startDate}..${data.range.endDate}`, data });
  if (await seoOpen()) return { clicks: data.total.clicks, skipped: "an SEO change is still on its way" };
  const out = await ask({
    task: "seo.weekly",
    tier: "write",
    system: `You are the SEO lead for seetharamakalyana.in, a matrimony site for Kannada, Telugu, Tamil and Hindi families.
${config.brief}
You may only change the blog pages (/blogs and its posts; the code lives in ${BLOG_DIR}). Within the blogs you have full freedom: new posts for queries people search, rewriting posts, titles, descriptions, FAQs, internal links between posts, links from posts to the site's pages. Nothing outside the blogs.
Only propose a change when it is worth it: a clear search opportunity in the data (impressions with few clicks, queries no post answers, posts slipping). Otherwise say it isn't worth changing this week. Never suggest fake reviews or claims.`,
    prompt: `Search Console, ${data.range.startDate} to ${data.range.endDate}:
Clicks ${data.total.clicks} (previous 28 days ${data.previous.clicks}), impressions ${data.total.impressions} (previous ${data.previous.impressions}).
Top queries: ${data.queries.map((q) => `${q.key} — ${q.clicks} clicks, ${q.impressions} impr, pos ${q.position.toFixed(1)}`).join("; ")}
Top pages: ${data.pages.map((p) => `${p.key} — ${p.clicks}/${p.impressions}`).join("; ")}
Is a blog change worth making this week? If so, give up to 3 concrete blog changes.`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["worth", "why", "title", "changes"],
      properties: {
        worth: { type: "boolean" },
        why: { type: "string", description: "One or two lines: what in the data makes it worth it, or why not" },
        title: { type: "string", description: "Short name of this week's blog change, max 8 words" },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["what", "detail"],
            properties: { what: { type: "string" }, detail: { type: "string", description: "Exactly what to write or change in the blogs" } },
          },
        },
      },
    },
    maxTokens: 2000,
  });
  const changes = (out.changes ?? []).slice(0, 3);
  if (!out.worth || !changes.length || !devConfigured()) return { clicks: data.total.clicks, worth: false, why: out.why };
  const card = await propose("seo", {
    type: "dev.request",
    status: "scheduled",
    runAt: new Date(),
    title: `SEO: ${out.title}`.slice(0, 160),
    reason: out.why,
    effect: `The Developer agent writes it in the blogs only, and it goes live by itself once the preview builds. Anything touching a file outside the blogs is refused. ${changes.map((c) => c.what).join("; ")}`,
    payload: {
      repo: "fe",
      mode: "write",
      seo: true,
      request: `SEO blog change: ${out.title}\n\n${changes.map((c, n) => `${n + 1}. ${c.what}: ${c.detail}`).join("\n")}\n\n${SEO_RULE}`,
      dedupeKey: `seo:${data.range.endDate}`,
    },
  });
  return { clicks: data.total.clicks, worth: true, scheduled: card ? String(card._id) : null };
};

/**
 * Checks the agent's change and deploys it by itself, but only when every
 * changed file is inside the blogs, the branch has stopped moving for 30
 * minutes and its Vercel preview built. Anything else is refused and closed.
 */
export const checkSeoChange = async (action) => {
  const { issue, requestedAt } = action.payload;
  const path = repoPath("fe");
  const late = Date.now() - new Date(requestedAt ?? action.createdAt).getTime() > GIVE_UP_MS;
  const close = async (why) => {
    const pulls = await gh("GET", `${path}/pulls?state=open&per_page=50`).catch(() => []);
    const pr = pulls.find((p) => new RegExp(`#${issue}\\b`).test(p.body || "") || (p.head?.ref || "").includes(`issue-${issue}`));
    if (pr) await gh("PATCH", `${path}/pulls/${pr.number}`, { state: "closed" }).catch(() => {});
    await gh("POST", `${path}/issues/${issue}/comments`, { body: `Not deployed: ${why}` }).catch(() => {});
    await gh("PATCH", `${path}/issues/${issue}`, { state: "closed", state_reason: "not_planned" }).catch(() => {});
    await notice("seo", {
      type: "seo.refused",
      title: `SEO change not deployed: ${action.title.replace(/^SEO:\s*/, "")}`.slice(0, 160),
      reason: why,
      effect: "Nothing went live. The agent tries again at a later weekly check if it's still worth it.",
      payload: { dedupeKey: `seo.refused:${issue}` },
    });
    return { deployed: false, why };
  };

  const branch = await agentBranch(path, issue);
  if (!branch) {
    if (late) return close("the Developer agent didn't push a change within 3 days.");
    throw new Defer("Waiting for the Developer agent to write the change", 3600000);
  }
  const cmp = await gh("GET", `${path}/compare/master...${branch.sha}`);
  const files = cmp.files ?? [];
  if (!files.length) return close("the agent's branch has no changes.");
  if (files.length >= 300) return close("the change is far too large for a blog update.");
  if (!blogOnly(files)) {
    const outside = files.filter((f) => !blogOnly([f])).map((f) => f.filename);
    return close(`it changed files outside the blogs (${outside.slice(0, 5).join(", ")}${outside.length > 5 ? "…" : ""}). Only ${BLOG_DIR} may change.`);
  }
  // The agent may still be pushing: wait until the branch hasn't moved for 30 minutes.
  if (action.payload.lastSha !== branch.sha) {
    action.payload = { ...action.payload, lastSha: branch.sha };
    throw new Defer("Waiting for the change to settle", 30 * 60000);
  }
  const preview = await previewFor(path, branch.sha).catch(() => null);
  if (preview?.state === "failure" || preview?.state === "error") return close("its preview build failed, so it would break the site.");
  if (preview?.state !== "success") {
    if (late) return close("its preview never finished building.");
    throw new Defer("Waiting for the preview to build", 30 * 60000);
  }
  const r = await deploy("fe", issue, { sha: branch.sha });
  await notice("seo", {
    type: "seo.deployed",
    title: `SEO change live: ${action.title.replace(/^SEO:\s*/, "")}`.slice(0, 160),
    reason: action.reason,
    effect: `Changed in the blogs only: ${files.map((f) => f.filename.slice(BLOG_DIR.length)).join(", ")}.`,
    payload: { dedupeKey: `seo.deployed:${issue}`, preview: preview.url },
  });
  return { deployed: !!r.merged, sha: r.sha, files: files.map((f) => f.filename) };
};

handle("seo.deploy", checkSeoChange);
