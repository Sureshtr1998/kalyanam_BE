import jwt from "jsonwebtoken";
import { OpsAction, OpsConfig, OpsReport, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { Defer, handle, notice, propose } from "./actions.js";
import { agentBranch, deploy, devConfigured, gh, previewFor, repoPath } from "./dev.js";

/*
 * SEO, run by the agent (owner, 28 Nov 2026: "you have full freedom under
 * blogs"). Search Console is read only, through a Google Cloud service account
 * (GSC_SERVICE_ACCOUNT_JSON) added as a user on the property.
 *
 *  1. Monday 9:00  seoIndex     which blog posts Google has indexed (URL Inspection)
 *  2. Monday 11:00 seoWeekly    Search Console numbers + the plan in
 *                               src/screens/blogs/SEO_PLAN.md decide one blog change, if worth it
 *  3. dev.request               the Developer agent (GitHub Action) writes it on a branch
 *  4. seo.deploy                goes live by itself only if every changed file is under
 *                               src/screens/blogs/, the branch has settled and its preview built
 *  5. seo.ping                  once live: changed URLs (sitemap lastmod) go to IndexNow
 *                               (Bing, which feeds ChatGPT search and Copilot)
 *  6. seo.index_check           Google indexing checked at 3, 7 and 14 days; still missing
 *                               at 14 days → one follow-up change that links to those posts
 *
 * Google has no API to "request indexing" for normal pages (its Indexing API is
 * only for job postings and livestreams), so Google finds changes through the
 * sitemap's lastmod and internal links.
 */

/** The only folder the SEO agent may change (website repo). */
export const BLOG_DIR = "src/screens/blogs/";
export const PLAN_PATH = `${BLOG_DIR}SEO_PLAN.md`;
/** True when every changed file (and a renamed file's old path) is inside the blogs. */
export const blogOnly = (files) =>
  files.length > 0 && files.every((f) => f.filename?.startsWith(BLOG_DIR) && (!f.previous_filename || f.previous_filename.startsWith(BLOG_DIR)));

const SEO_RULE = `HARD RULE: change files under ${BLOG_DIR} only (blog posts, their titles, descriptions, FAQs, internal links between posts, new posts in blogsContents.tsx and the post files, and ${PLAN_PATH}). Do not touch any other file, not even package files, images in src/assets, routes, the sitemap or shared components; new posts are picked up by the build automatically. If the change can't be made inside ${BLOG_DIR}, change nothing and say so.
Read ${PLAN_PATH} first and follow "How every post is written" (direct answer, key facts, question headings, FAQs, internal links, updatedAt set to today on every post you add or change). Then add one line at the top of its Log: today's date, what changed, which pages.
Keep every claim honest: no invented success stories, member counts, testimonials, ratings or promises. Run npm run build before you finish.`;
const GIVE_UP_MS = 3 * 86400000;
const DAY = 86400000;
const HOUR = 3600000;
/** Days after going live when Google's indexing is checked. */
export const INDEX_CHECK_DAYS = [3, 7, 14];
/** IndexNow key: public by design (search engines check it at <site>/<key>.txt, in the website's public/). */
const INDEXNOW_KEY = "5385efc73f80afcd6506846e63e802bb";

export const seoConfigured = () => !!process.env.GSC_SERVICE_ACCOUNT_JSON;
const SITE = () => process.env.GSC_SITE || "sc-domain:seetharamakalyana.in";
export const SITE_URL = () => (process.env.SITE_URL || "https://www.seetharamakalyana.in").replace(/\/+$/, "");

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
  const [byDay, queries, pages, queryPages, prev] = await Promise.all([
    query({ ...range, dimensions: ["date"] }),
    query({ ...range, dimensions: ["query"], rowLimit: 250 }),
    query({ ...range, dimensions: ["page"], rowLimit: 60 }),
    query({ ...range, dimensions: ["query", "page"], rowLimit: 250 }),
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
    queryPages: queryPages.map((r) => ({ query: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: r.position })),
  };
};

/* ----------------------- sitemap, IndexNow, indexing ----------------------- */

/** The live sitemap as { url: lastmod }. */
export const liveSitemap = async () => {
  const res = await fetch(`${SITE_URL()}/sitemap.xml`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Sitemap: ${res.status}`);
  const out = {};
  for (const m of (await res.text()).matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (loc) out[loc] = m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? "";
  }
  return out;
};

/** URLs that are new or whose lastmod changed between two sitemaps. */
export const changedUrls = (before, after) => Object.keys(after).filter((u) => before[u] !== after[u]);

/** Tells Bing (ChatGPT search, Copilot), Yandex, Seznam and Naver that these URLs changed. */
export const pingIndexNow = async (urls) => {
  const site = SITE_URL();
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(site).host, key: INDEXNOW_KEY, keyLocation: `${site}/${INDEXNOW_KEY}.txt`, urlList: urls.slice(0, 1000) }),
    signal: AbortSignal.timeout(15000),
  });
  // 200 = accepted, 202 = accepted while the key is checked.
  if (!res.ok) throw new Error(`IndexNow: ${res.status} ${res.statusText}`);
  return res.status;
};

/** Google's view of one URL (URL Inspection API, read only). indexed: true / false, or null if the check failed. */
export const inspectUrl = async (url) => {
  try {
    const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: SITE() }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || String(res.status));
    const r = data.inspectionResult?.indexStatusResult ?? {};
    return { url, indexed: r.verdict === "PASS", state: r.coverageState || r.verdict || "unknown", lastCrawl: r.lastCrawlTime ?? null };
  } catch (err) {
    return { url, indexed: null, state: `check failed: ${String(err.message).slice(0, 120)}`, lastCrawl: null };
  }
};

const inspectAll = async (urls, n = 6) => {
  const out = [];
  for (let i = 0; i < urls.length; i += n) out.push(...(await Promise.all(urls.slice(i, i + n).map(inspectUrl))));
  return out;
};

/** Weekly (Monday 9:00): which blog posts Google has indexed, kept for the 11:00 read. */
export const runSeoIndex = async () => {
  const urls = Object.keys(await liveSitemap()).filter((u) => /\/blog(\/|$)/.test(u));
  const results = await inspectAll(urls);
  if (results.length && results.every((r) => r.indexed === null)) throw new Error(`URL inspection failed: ${results[0].state}`);
  await OpsConfig.updateOne({ _id: "ops" }, { $set: { seoIndex: { at: new Date(), results } } });
  return { checked: results.length, indexed: results.filter((r) => r.indexed).length };
};

/* ------------------------------ the plan ------------------------------ */

/** The SEO plan in the website repo (the agent keeps it current; it lives inside the blogs). */
export const readPlan = async () => {
  if (!devConfigured()) return "";
  const f = await gh("GET", `${repoPath("fe")}/contents/${PLAN_PATH}?ref=master`).catch(() => null);
  return f?.content ? Buffer.from(f.content, "base64").toString("utf8").slice(0, 16000) : "";
};

/** An SEO change still on its way (being written, waiting to deploy or to go live). */
const seoOpen = () =>
  OpsAction.findOne({ module: "seo", type: { $in: ["dev.request", "seo.deploy", "seo.ping"] }, status: { $in: ["scheduled", "running", "shadow", "needs_you"] } }).lean();

const rowText = (q) => `${q.key} | ${q.clicks} clicks | ${q.impressions} impr | pos ${q.position.toFixed(1)}`;

export const runSeoWeekly = async () => {
  const config = await getConfig();
  const data = await fetchSeo();
  await OpsReport.create({ kind: "seo", period: `${data.range.startDate}..${data.range.endDate}`, data });
  if (await seoOpen()) return { clicks: data.total.clicks, skipped: "an SEO change is still on its way" };
  const [plan, recent] = await Promise.all([
    readPlan(),
    OpsAction.find({ module: "seo", type: { $in: ["seo.deployed", "seo.refused"] }, createdAt: { $gte: new Date(Date.now() - 120 * DAY) } })
      .sort({ createdAt: -1 })
      .limit(12)
      .lean(),
  ]);
  const index = config.seoIndex?.results ?? [];
  const notIndexed = index.filter((r) => r.indexed === false);
  const out = await ask({
    task: "seo.weekly",
    tier: "write",
    system: `You are the SEO lead for seetharamakalyana.in, a Hindu matrimony site (Kannada, Telugu, Tamil and Hindi families first, all of India).
${config.brief}
You may only change the blog pages (/blog and its posts; the code lives in ${BLOG_DIR}). Within the blogs you have full freedom: new posts for what people search, rewriting posts, titles, descriptions, FAQs, internal links between posts, links from posts to the site's pages. Nothing outside the blogs.
The goal is registrations, not just visits. Follow the SEO plan below; it ranks the work. Pick the single most valuable next step for this week (one new post, or one rewrite plus title fixes): usually the plan's highest open priority, unless the data shows a better opening or a past change needs fixing. Judge past changes on their pages' impressions, position and clicks.
Only propose a change when it is worth it; otherwise say so. Never suggest invented success stories, counts, testimonials, ratings or promises.

SEO PLAN (${PLAN_PATH}):
${plan || "(not available this week: use the data alone)"}`,
    prompt: `Search Console, ${data.range.startDate} to ${data.range.endDate}:
Clicks ${data.total.clicks} (previous 28 days ${data.previous.clicks}), impressions ${data.total.impressions} (previous ${data.previous.impressions}).

Queries (query | clicks | impressions | average position):
${data.queries.filter((q) => q.impressions >= 2 || q.clicks > 0).map(rowText).join("\n")}

Pages:
${data.pages.map(rowText).join("\n")}

Which page shows for which query (query → page, impressions, position):
${data.queryPages.filter((r) => r.impressions >= 2).slice(0, 150).map((r) => `${r.query} → ${r.page.replace(SITE_URL(), "")} | ${r.impressions} | ${r.position.toFixed(1)}`).join("\n")}

Blog posts Google has NOT indexed (checked ${config.seoIndex?.at ? new Date(config.seoIndex.at).toISOString().slice(0, 10) : "–"}): ${notIndexed.length ? notIndexed.map((r) => `${r.url.replace(SITE_URL(), "")} (${r.state})`).join("; ") : index.length ? "none" : "not checked yet"}

Recent SEO changes: ${recent.length ? recent.map((r) => `${new Date(r.createdAt).toISOString().slice(0, 10)} ${r.title}: ${r.effect ?? r.reason ?? ""}`).join(" || ") : "none yet"}

Is a blog change worth making this week? If so, give the change as up to 3 concrete steps for the Developer agent.`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["worth", "why", "title", "changes"],
      properties: {
        worth: { type: "boolean" },
        why: { type: "string", description: "One or two lines: what in the data and the plan makes it worth it, or why not" },
        title: { type: "string", description: "Short name of this week's blog change, max 8 words" },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["what", "detail"],
            properties: {
              what: { type: "string" },
              detail: { type: "string", description: "Exactly what to write or change in the blogs: target queries, slug, title, headings, FAQs, which posts to link" },
            },
          },
        },
      },
    },
    maxTokens: 3000,
  });
  const changes = (out.changes ?? []).slice(0, 3);
  if (!out.worth || !changes.length || !devConfigured()) return { clicks: data.total.clicks, worth: false, why: out.why };
  const card = await propose("seo", {
    type: "dev.request",
    status: "scheduled",
    runAt: new Date(),
    title: `SEO: ${out.title}`.slice(0, 160),
    reason: out.why,
    effect: `The Developer agent writes it in the blogs only, and it goes live by itself once the preview builds; then Bing is pinged and Google's indexing is checked. Anything touching a file outside the blogs is refused. ${changes.map((c) => c.what).join("; ")}`,
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

/* ----------------------------- going live ----------------------------- */

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
    throw new Defer("Waiting for the Developer agent to write the change", HOUR);
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
  // The live sitemap before the change, to see afterwards which pages changed ([url, lastmod] pairs:
  // URLs can't be field names in the database).
  const sitemapBefore = await liveSitemap()
    .then((m) => Object.entries(m))
    .catch(() => null);
  const r = await deploy("fe", issue, { sha: branch.sha });
  await notice("seo", {
    type: "seo.deployed",
    title: `SEO change live: ${action.title.replace(/^SEO:\s*/, "")}`.slice(0, 160),
    reason: action.reason,
    effect: `Changed in the blogs only: ${files.map((f) => f.filename.slice(BLOG_DIR.length)).join(", ")}.`,
    payload: { dedupeKey: `seo.deployed:${issue}`, preview: preview.url },
  });
  return {
    deployed: !!r.merged,
    sha: r.sha,
    files: files.map((f) => f.filename),
    // Next: once the production deploy is live, ping IndexNow with the changed pages.
    next: { type: "seo.ping", runAt: new Date(Date.now() + 15 * 60000), payload: { sitemapBefore, deployedAt: new Date() } },
  };
};

/** Once the change is live on the site: the changed pages go to IndexNow, and Google's indexing check is scheduled. */
export const pingChanged = async (action) => {
  const { sitemapBefore, deployedAt } = action.payload;
  const since = Date.now() - new Date(deployedAt).getTime();
  const after = await liveSitemap();
  let urls = sitemapBefore ? changedUrls(Object.fromEntries(sitemapBefore), after) : Object.keys(after).filter((u) => after[u] >= ymd(new Date(deployedAt)));
  if (!urls.length) {
    // Not live yet, or the agent forgot to bump updatedAt: wait up to 3 hours, then ping the blog list.
    if (since < 3 * HOUR) throw new Defer("Waiting for the change to be live on the site", 20 * 60000);
    urls = [`${SITE_URL()}/blog`];
  }
  const status = await pingIndexNow(urls);
  if (seoConfigured()) {
    await propose("seo", {
      type: "seo.index_check",
      status: "scheduled",
      runAt: new Date(new Date(deployedAt).getTime() + INDEX_CHECK_DAYS[0] * DAY),
      title: `Google indexing check: ${urls.map((u) => u.replace(SITE_URL(), "") || "/").slice(0, 3).join(", ")}${urls.length > 3 ? ` +${urls.length - 3}` : ""}`.slice(0, 160),
      reason: action.title,
      effect: `Checks with Google at ${INDEX_CHECK_DAYS.join(", ")} days. Pages still not indexed after ${INDEX_CHECK_DAYS.at(-1)} days get one follow-up change that links to them from posts that rank.`,
      payload: { urls, deployedAt, round: 0, indexFix: !!action.payload.indexFix, dedupeKey: `seo.index:${new Date(deployedAt).toISOString()}` },
    });
  }
  return { pinged: urls, indexNow: status };
};

/** Google indexing at 3, 7 and 14 days; still missing at 14 days → one follow-up change (never a follow-up of a follow-up). */
export const checkIndexing = async (action) => {
  const { urls, deployedAt } = action.payload;
  const round = action.payload.round ?? 0;
  const results = await inspectAll(urls);
  const history = [...(action.payload.history ?? []), { round, at: new Date(), results }];
  const missing = results.filter((r) => r.indexed === false);
  const unknown = results.filter((r) => r.indexed === null);
  if (!missing.length && !unknown.length) return { indexed: urls.length, results };
  if (round + 1 < INDEX_CHECK_DAYS.length) {
    action.payload = { ...action.payload, round: round + 1, history };
    const next = new Date(deployedAt).getTime() + INDEX_CHECK_DAYS[round + 1] * DAY;
    throw new Defer(`${missing.length + unknown.length} of ${urls.length} not indexed yet: ${[...missing, ...unknown].map((m) => m.state).join(", ")}`, Math.max(HOUR, next - Date.now()));
  }
  const blogMissing = missing.filter((m) => /\/blog\//.test(m.url));
  if (!blogMissing.length || action.payload.indexFix || !devConfigured()) {
    return { indexed: urls.length - missing.length - unknown.length, missing: missing.map((m) => `${m.url} (${m.state})`), unknown: unknown.length };
  }
  if (await seoOpen()) {
    action.payload = { ...action.payload, history };
    throw new Defer("Waiting for the SEO change in progress", DAY);
  }
  const list = blogMissing.map((m) => `${m.url.replace(SITE_URL(), "")} (${m.state})`).join("; ");
  await propose("seo", {
    type: "dev.request",
    status: "scheduled",
    runAt: new Date(),
    title: `SEO: help Google index ${blogMissing.length} blog post${blogMissing.length > 1 ? "s" : ""}`,
    reason: `Not indexed ${INDEX_CHECK_DAYS.at(-1)} days after going live: ${list}.`,
    effect: "Adds links to them from blog posts that already rank and strengthens their direct answers and FAQs. Blogs only; goes live by itself.",
    payload: {
      repo: "fe",
      mode: "write",
      seo: true,
      indexFix: true,
      request: `SEO: Google hasn't indexed these blog posts ${INDEX_CHECK_DAYS.at(-1)} days after they went live: ${list}.
1. Add a natural, relevant link to each of them (with BlogLink) from 2–3 blog posts that already rank and are on a related topic.
2. Make sure each has a clear direct answer (answer), key facts, question-style headings and 3–5 FAQs, and is clearly different from the other posts (no near-duplicates). Set updatedAt to today on every post you change.

${SEO_RULE}`,
      dedupeKey: `seo.index_fix:${new Date(deployedAt).toISOString()}`,
    },
  });
  return { indexed: urls.length - missing.length - unknown.length, missing: missing.map((m) => `${m.url} (${m.state})`), followUp: true };
};

handle("seo.deploy", checkSeoChange);
handle("seo.ping", pingChanged);
handle("seo.index_check", checkIndexing);
