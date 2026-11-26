/*
 * Meta Graph / Marketing API calls for the ops agent. Uses the system-user
 * token in META_ADS_TOKEN. Reading needs ads_read; changing budgets needs
 * ads_management; comments and posts need the Page and Instagram
 * permissions (see .env.example). The token never leaves the server.
 */

const GRAPH = "https://graph.facebook.com/v22.0";

export const LEAD_ACTIONS = ["offsite_conversion.fb_pixel_lead", "lead"];
export const PAID_ACTIONS = ["offsite_conversion.fb_pixel_complete_registration", "complete_registration"];

export const metaConfigured = () => !!process.env.META_ADS_TOKEN && !!accountId();
/*
 * The Facebook Page and Instagram account are found from the token itself
 * (the Page assigned to the system user, and its linked Instagram account),
 * so META_PAGE_ID / META_IG_USER_ID are only needed to override that.
 */
let pageCache = { pageId: null, igId: null, at: 0, error: null };
const PAGE = () => process.env.META_PAGE_ID || pageCache.pageId;
const IG = () => process.env.META_IG_USER_ID || pageCache.igId;

/** Finds the Page and its Instagram account (cached for an hour). */
export const resolvePage = async () => {
  if (!process.env.META_ADS_TOKEN) return null;
  if (process.env.META_PAGE_ID && process.env.META_IG_USER_ID) return { pageId: PAGE(), igId: IG() };
  if (pageCache.at && Date.now() - pageCache.at < 3600_000) return pageCache.pageId ? pageCache : null;
  try {
    const r = await graphGet("me/accounts", { fields: "id,name,instagram_business_account", limit: 25 });
    const page = (r.data ?? []).find((p) => !process.env.META_PAGE_ID || p.id === process.env.META_PAGE_ID) ?? null;
    pageCache = { pageId: page?.id ?? null, igId: page?.instagram_business_account?.id ?? null, name: page?.name, at: Date.now(), error: page ? null : "No Facebook Page is assigned to the system user" };
  } catch (err) {
    pageCache = { pageId: null, igId: null, at: Date.now(), error: err.message };
  }
  return pageCache.pageId ? pageCache : null;
};

export const pageConfigured = () => !!process.env.META_ADS_TOKEN && !!PAGE();
export const igConfigured = () => pageConfigured() && !!IG();
export const pageLookupError = () => pageCache.error;

export const accountId = () => {
  const raw = String(process.env.META_AD_ACCOUNT_ID || "").trim();
  return raw ? (raw.startsWith("act_") ? raw : `act_${raw}`) : "";
};

const encode = (params) =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));

const call = async (method, pathOrUrl, params = {}, token = process.env.META_ADS_TOKEN) => {
  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}/${pathOrUrl}`);
  /** @type {RequestInit} */
  const init = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) };
  if (method === "GET" || method === "DELETE") {
    for (const [k, v] of Object.entries(encode(params))) url.searchParams.set(k, v);
  } else {
    init.body = new URLSearchParams(encode(params));
  }
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw Object.assign(new Error(body.error?.message || `Meta API ${res.status}`), { meta: body.error });
  }
  return body;
};

export const graphGet = (path, params, token) => call("GET", path, params, token);
export const graphPost = (path, params, token) => call("POST", path, params, token);
export const graphDelete = (path, token) => call("DELETE", path, {}, token);

/** Follows `paging.next` until done (or `max` rows). */
export const graphAll = async (path, params, token, max = 2000) => {
  const rows = [];
  let page = await graphGet(path, params, token);
  for (;;) {
    rows.push(...(page.data ?? []));
    if (!page.paging?.next || rows.length >= max) return rows;
    page = await graphGet(page.paging.next, {}, token);
  }
};

/** First matching action count (Meta reports the same event under several names). */
export const actionCount = (actions, types) => {
  for (const type of types) {
    const hit = actions?.find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
};

/** "YYYY-MM-DD" in the given IANA zone, `back` days ago. */
export const dayIn = (tz, back = 0) =>
  new Date(Date.now() - back * 86400000).toLocaleDateString("en-CA", { timeZone: tz });

/**
 * The ad account and its money. For a prepaid account the spendable balance
 * only appears inside funding_source_details.display_string, e.g.
 * "Available balance (₹4,288.12 INR)", so it is read from there.
 */
export const fetchAccount = async () => {
  const a = await graphGet(accountId(), {
    fields: "name,currency,timezone_name,account_status,balance,amount_spent,spend_cap,is_prepay_account,funding_source_details",
  });
  const display = String(a.funding_source_details?.display_string || "");
  const m = display.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  const available = a.is_prepay_account && m ? Number(m[1]) : null;
  const cap = Number(a.spend_cap) || 0;
  return {
    id: accountId(),
    name: a.name,
    currency: a.currency,
    timezone: a.timezone_name || "Asia/Kolkata",
    status: a.account_status,
    prepaid: !!a.is_prepay_account,
    // Amounts from Meta are in paise.
    available,
    spendCapLeft: cap ? (cap - Number(a.amount_spent || 0)) / 100 : null,
    fundingLabel: display || null,
  };
};

/** Campaigns and ad sets with budgets (₹) and status. */
export const fetchStructure = async () => {
  const act = accountId();
  const [campaigns, adsets] = await Promise.all([
    graphAll(`${act}/campaigns`, { fields: "id,name,daily_budget,effective_status", limit: 200 }),
    graphAll(`${act}/adsets`, { fields: "id,name,campaign_id,daily_budget,effective_status,updated_time", limit: 200 }),
  ]);
  const rupees = (v) => (v ? Number(v) / 100 : null);
  return {
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, dailyBudget: rupees(c.daily_budget), status: c.effective_status })),
    adsets: adsets.map((s) => ({
      id: s.id,
      name: s.name,
      campaignId: s.campaign_id,
      dailyBudget: rupees(s.daily_budget),
      status: s.effective_status,
      updatedAt: s.updated_time,
    })),
  };
};

/** Daily insights for every entity at `level` between two dates. */
export const fetchInsights = async (level, since, until, breakdowns) => {
  const idField = { campaign: "campaign_id", adset: "adset_id", ad: "ad_id", account: "account_id" }[level];
  const nameField = { campaign: "campaign_name", adset: "adset_name", ad: "ad_name", account: "account_name" }[level];
  const rows = await graphAll(`${accountId()}/insights`, {
    level,
    fields: [idField, nameField, "campaign_id", "campaign_name", "adset_id", "spend", "impressions", "reach", "frequency", "inline_link_clicks", "ctr", "actions"]
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(","),
    time_range: { since, until },
    time_increment: 1,
    limit: 500,
    ...(breakdowns ? { breakdowns } : {}),
  });
  return rows.map((r) => ({
    date: r.date_start,
    entityId: breakdowns ? `${r.publisher_platform}` : r[idField],
    name: breakdowns ? r.publisher_platform : r[nameField],
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    adsetId: r.adset_id,
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    reach: Number(r.reach) || 0,
    frequency: Number(r.frequency) || 0,
    clicks: Number(r.inline_link_clicks) || 0,
    ctr: Number(r.ctr) || 0,
    leads: actionCount(r.actions, LEAD_ACTIONS),
    paid: actionCount(r.actions, PAID_ACTIONS),
  }));
};

/** Sets a campaign's or ad set's daily budget (₹). Needs ads_management. */
export const setDailyBudget = (entityId, rupees) =>
  graphPost(entityId, { daily_budget: String(Math.round(rupees * 100)) });

export const setStatus = (entityId, status) => graphPost(entityId, { status });

/* ------------------------- creating ads and ad sets ------------------------ */

/** Every ad with its ad set, status, age, creative id and any delivery issue. */
export const fetchAds = () =>
  graphAll(`${accountId()}/ads`, {
    fields: "id,name,adset_id,campaign_id,effective_status,created_time,creative{id},issues_info",
    limit: 300,
  });

/** Ads Meta has disapproved or flagged, in campaigns that are meant to be running. */
export const adIssuesFrom = (ads, activeCampaignIds) =>
  ads
    .filter((a) => ["DISAPPROVED", "WITH_ISSUES"].includes(a.effective_status) && activeCampaignIds.has(a.campaign_id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      effective_status: a.effective_status,
      issue: a.issues_info?.[0]?.error_summary || a.issues_info?.[0]?.error_message || "",
    }));

/** Uploads a JPEG (base64) to the ad account's image library; returns its hash. */
export const uploadAdImage = async (base64, name) => {
  const r = await graphPost(`${accountId()}/adimages`, { bytes: base64, name });
  const first = Object.values(r.images ?? {})[0];
  if (!first?.hash) throw new Error("Meta didn't return an image hash");
  return first.hash;
};

/** The creative spec of an ad (link, CTA, page, tracking), to base a new creative on. */
export const fetchCreativeSpec = async (adId) => {
  const ad = await graphGet(adId, { fields: "creative{object_story_spec,asset_feed_spec,url_tags,degrees_of_freedom_spec}" });
  return ad.creative;
};

export const createCreative = (fields) => graphPost(`${accountId()}/adcreatives`, fields);

/**
 * An ad's image as base64 (for Claude to see what the card says), or null.
 * Image ads give image_url; others fall back to the thumbnail. Max 2 MB.
 */
export const fetchAdImage = async (adId) => {
  try {
    const ad = await graphGet(adId, { fields: "creative{image_url,thumbnail_url}" });
    const url = ad.creative?.image_url || ad.creative?.thumbnail_url;
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const type = String(res.headers.get("content-type") || "").split(";")[0];
    if (!res.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= 2 * 1024 * 1024 ? { mediaType: type, data: buf.toString("base64") } : null;
  } catch {
    return null;
  }
};

/** Copies an ad into an ad set (keeps its tracking and settings), paused. */
export const copyAd = async (adId, adsetId) => {
  const r = await graphPost(`${adId}/copies`, { adset_id: adsetId, status_option: "PAUSED" });
  return r.copied_ad_id ?? r.ad_object_ids?.[0]?.copied_id;
};

/**
 * Copies an ad set without its ads, paused. (A deep copy of an ad set with
 * more than 3 ads exceeds Meta's synchronous copy limit, so ads are copied
 * one by one with copyAd.)
 */
export const copyAdset = async (adsetId) => {
  const r = await graphPost(`${adsetId}/copies`, { deep_copy: "false", status_option: "PAUSED" });
  return r.copied_adset_id ?? r.ad_object_ids?.[0]?.copied_id;
};

export const fetchAdset = (adsetId) => graphGet(adsetId, { fields: "id,name,campaign_id,daily_budget,targeting,effective_status" });

/** True when Meta's Advantage+ audience is on: ages and gender are then only suggestions, and age_min can't go above 25. */
export const usesAdvantageAudience = (targeting) => Number(targeting?.targeting_automation?.advantage_audience) === 1;

/** Finds Meta's location key for a city, region or country name. */
export const searchLocation = async (q) => {
  const r = await graphGet("search", { type: "adgeolocation", q, location_types: ["city", "region", "country"], limit: 1 });
  return r.data?.[0] ?? null;
};

/* ---------------------------- Page & Instagram ---------------------------- */

let pageTokenCache = { token: null, at: 0 };
/** The Page access token, derived from the system-user token (cached 1 h). */
export const pageToken = async () => {
  if (pageTokenCache.token && Date.now() - pageTokenCache.at < 3600_000) return pageTokenCache.token;
  const { access_token } = await graphGet(PAGE(), { fields: "access_token" });
  pageTokenCache = { token: access_token, at: Date.now() };
  return access_token;
};

/** The Facebook post and Instagram media behind each active ad (ads aren't in the Page feed). */
const adPosts = async () => {
  if (!metaConfigured()) return { facebook: [], instagram: [] };
  const ads = await graphAll(`${accountId()}/ads`, {
    fields: "effective_status,creative{effective_object_story_id,effective_instagram_media_id}",
    effective_status: ["ACTIVE"],
    limit: 200,
  }).catch(() => []);
  const fb = new Set();
  const ig = new Set();
  for (const a of ads) {
    if (a.creative?.effective_object_story_id) fb.add(a.creative.effective_object_story_id);
    if (a.creative?.effective_instagram_media_id) ig.add(a.creative.effective_instagram_media_id);
  }
  return { facebook: [...fb], instagram: [...ig] };
};

/** Recent comments on Page posts and on the Facebook posts behind active ads. */
export const fetchPageComments = async () => {
  const token = await pageToken();
  const posts = await graphGet(`${PAGE()}/feed`, {
    fields: "id,created_time,comments.limit(50).order(reverse_chronological){id,message,from,created_time,is_hidden}",
    limit: 15,
  }, token);
  const { facebook } = await adPosts();
  const seen = new Set((posts.data ?? []).map((p) => p.id));
  for (const id of facebook.filter((x) => !seen.has(x)).slice(0, 60)) {
    const c = await graphGet(`${id}/comments`, { fields: "id,message,from,created_time,is_hidden", order: "reverse_chronological", limit: 50 }, token).catch(() => null);
    if (c?.data?.length) posts.data.push({ id, comments: c });
  }
  return (posts.data ?? []).flatMap((p) =>
    (p.comments?.data ?? []).map((c) => ({
      platform: "facebook",
      commentId: c.id,
      postId: p.id,
      author: c.from?.name || "Someone",
      text: c.message || "",
      createdAt: new Date(c.created_time),
      hidden: !!c.is_hidden,
      // Our own Page's comments (e.g. our replies) are skipped.
      ours: c.from?.id === PAGE(),
    }))
  );
};

/** Recent Instagram comments, on posts and on the Instagram side of active ads. */
export const fetchIgComments = async () => {
  const token = await pageToken();
  const media = await graphGet(`${IG()}/media`, {
    fields: "id,timestamp,comments.limit(50){id,text,username,timestamp,hidden}",
    limit: 15,
  }, token);
  const { instagram } = await adPosts();
  const seen = new Set((media.data ?? []).map((m) => m.id));
  for (const id of instagram.filter((x) => !seen.has(x)).slice(0, 60)) {
    const c = await graphGet(`${id}/comments`, { fields: "id,text,username,timestamp,hidden", limit: 50 }, token).catch(() => null);
    if (c?.data?.length) media.data.push({ id, comments: c });
  }
  const me = await igUsername(token);
  return (media.data ?? []).flatMap((m) =>
    (m.comments?.data ?? []).map((c) => ({
      platform: "instagram",
      commentId: c.id,
      postId: m.id,
      author: c.username || "someone",
      text: c.text || "",
      createdAt: new Date(c.timestamp),
      hidden: !!c.hidden,
      ours: c.username === me,
    }))
  );
};

let igName = null;
const igUsername = async (token) => {
  igName ??= (await graphGet(IG(), { fields: "username" }, token)).username;
  return igName;
};

export const hideComment = async (platform, id) =>
  graphPost(id, platform === "instagram" ? { hide: "true" } : { is_hidden: "true" }, await pageToken());

export const deleteComment = async (id) => graphDelete(id, await pageToken());

export const replyToComment = async (platform, id, message) =>
  graphPost(platform === "instagram" ? `${id}/replies` : `${id}/comments`, { message }, await pageToken());

/** Schedules a Facebook photo post (Meta publishes it at `publishAt`). */
export const scheduleFacebookPhoto = async ({ imageUrl, caption, publishAt }) =>
  graphPost(`${PAGE()}/photos`, {
    url: imageUrl,
    caption,
    published: "false",
    scheduled_publish_time: String(Math.floor(new Date(publishAt).getTime() / 1000)),
  }, await pageToken());

/** Publishes an Instagram photo now (Instagram's API has no scheduling, so the tick calls this when due). */
export const publishInstagramPhoto = async ({ imageUrl, caption }) => {
  const token = await pageToken();
  const container = await graphPost(`${IG()}/media`, { image_url: imageUrl, caption }, token);
  return graphPost(`${IG()}/media_publish`, { creation_id: container.id }, token);
};

/** Turns a Meta error into one line an admin can act on. */
export const metaErrorText = (err) => {
  const code = err.meta?.code;
  const msg = String(err.meta?.message || err.message || "");
  if (code === 190) return "The Meta token has expired or is invalid. Generate a new one.";
  if (code === 10 || code === 200 || /permission/i.test(msg)) return `The Meta token is missing a permission: ${msg}`;
  if ([4, 17, 32, 613, 80000, 80004].includes(code)) return "Meta's rate limit was hit. It will retry on the next run.";
  return `Meta said: ${msg || "unknown error"}`;
};

/* ------------------------- organic post performance ------------------------ */

const settle = async (p) => {
  try {
    return await p;
  } catch {
    return null;
  }
};

/** The organic tracking code in a post's text (…?p=fkn1127), if any. */
export const codeIn = (text = "") => String(text).match(/[?&]p=([a-z0-9]{2,16})/i)?.[1]?.toLowerCase() ?? null;

const metricValue = (r, name) => r?.data?.find((m) => m.name === name)?.values?.[0]?.value ?? r?.data?.find((m) => m.name === name)?.total_value?.value ?? null;

/**
 * How recent organic posts did (last `days` days): reach, engagement
 * (reactions + comments + shares on Facebook; likes + comments + saves +
 * shares on Instagram), link clicks (Facebook) and profile visits
 * (Instagram, where links in captions can't be clicked), plus the post's
 * tracking code so sign-ups can be matched. Missing metrics are left out
 * rather than failing.
 */
export const fetchPostPerformance = async (days = 28) => {
  await resolvePage();
  if (!PAGE()) return [];
  const token = await pageToken();
  const since = Math.floor((Date.now() - days * 86400000) / 1000);
  const out = [];
  const fb = await settle(
    graphGet(`${PAGE()}/published_posts`, {
      fields: "id,message,created_time,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
      since: String(since),
      limit: 40,
    }, token)
  );
  for (const p of fb?.data ?? []) {
    const [reach, clicks] = await Promise.all([
      settle(graphGet(`${p.id}/insights`, { metric: "post_impressions_unique" }, token)),
      settle(graphGet(`${p.id}/insights`, { metric: "post_clicks_by_type" }, token)),
    ]);
    const byType = metricValue(clicks, "post_clicks_by_type");
    out.push({
      id: p.id,
      platform: "facebook",
      at: p.created_time,
      text: String(p.message || "").slice(0, 160),
      code: codeIn(p.message),
      reach: metricValue(reach, "post_impressions_unique"),
      engagement: (p.reactions?.summary?.total_count ?? 0) + (p.comments?.summary?.total_count ?? 0) + (p.shares?.count ?? 0),
      linkClicks: byType && typeof byType === "object" ? Number(byType["link clicks"] ?? 0) : null,
    });
  }
  if (IG()) {
    const ig = await settle(graphGet(`${IG()}/media`, { fields: "id,caption,timestamp,like_count,comments_count,media_type", limit: 40 }, token));
    for (const m of (ig?.data ?? []).filter((x) => Date.parse(x.timestamp) / 1000 >= since)) {
      const [reach, extra, visits] = await Promise.all([
        settle(graphGet(`${m.id}/insights`, { metric: "reach" }, token)),
        settle(graphGet(`${m.id}/insights`, { metric: "saved,shares" }, token)),
        settle(graphGet(`${m.id}/insights`, { metric: "profile_visits" }, token)),
      ]);
      out.push({
        id: m.id,
        platform: "instagram",
        at: m.timestamp,
        text: String(m.caption || "").slice(0, 160),
        code: codeIn(m.caption),
        format: m.media_type,
        reach: metricValue(reach, "reach"),
        engagement: (m.like_count ?? 0) + (m.comments_count ?? 0) + (metricValue(extra, "saved") ?? 0) + (metricValue(extra, "shares") ?? 0),
        profileVisits: metricValue(visits, "profile_visits"),
      });
    }
  }
  return out;
};

/**
 * Posts scheduled on the Facebook Page (by hand in Business Suite or by the
 * agent). Throws when Meta can't be read, so the planner never mistakes a
 * failed read for "every evening is free" and double-posts.
 */
export const fetchScheduledPosts = async () => {
  await resolvePage();
  if (!PAGE()) throw new Error("No Facebook Page connected");
  const token = await pageToken();
  const rows = await graphAll(`${PAGE()}/scheduled_posts`, { fields: "id,message,scheduled_publish_time", limit: 100 }, token);
  return rows
    .map((p) => ({ id: p.id, at: new Date(Number(p.scheduled_publish_time) * 1000), message: String(p.message || "").slice(0, 120) }))
    .filter((p) => !Number.isNaN(p.at.getTime()));
};

export const fetchScheduledTimes = async () => (await fetchScheduledPosts()).map((p) => p.at);

/**
 * Instagram stories that are live now, with their insights. The API lists a
 * story only for its 24 hours, so this is read every few hours and the last
 * reading stands. Facebook Page stories aren't read: they get ~0 views.
 */
export const fetchLiveStories = async () => {
  await resolvePage();
  if (!IG()) return [];
  const token = await pageToken();
  const list = await graphGet(`${IG()}/stories`, { fields: "id,media_type,timestamp,permalink" }, token);
  const out = [];
  for (const s of list?.data ?? []) {
    const one = (metric) => settle(graphGet(`${s.id}/insights`, { metric }, token)).then((r) => metricValue(r, metric));
    const [reach, replies, shares, profileVisits, follows, nav] = await Promise.all([
      one("reach"),
      one("replies"),
      one("shares"),
      one("profile_visits"),
      one("follows"),
      settle(graphGet(`${s.id}/insights`, { metric: "navigation", breakdown: "story_navigation_action_type", metric_type: "total_value" }, token)),
    ]);
    const byAction = {};
    for (const r of nav?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? []) byAction[r.dimension_values?.[0]] = r.value;
    out.push({
      igId: s.id,
      at: new Date(s.timestamp),
      format: s.media_type,
      permalink: s.permalink,
      reach,
      replies,
      shares,
      profileVisits,
      follows,
      navigation: {
        forward: byAction.tap_forward ?? null,
        back: byAction.tap_back ?? null,
        exited: byAction.tap_exit ?? null,
        nextStory: byAction.swipe_forward ?? null,
      },
    });
  }
  return out;
};

/** Removes a scheduled (or published) Facebook post or photo the agent made. */
export const deleteFacebookPost = async (id) => graphDelete(id, await pageToken());

/** IST dates (YYYY-MM-DD) that already have a Facebook post scheduled in Meta (e.g. posted by hand). */
export const fetchScheduledDays = async () => {
  await resolvePage();
  if (!PAGE()) return [];
  const token = await pageToken();
  const r = await settle(graphGet(`${PAGE()}/scheduled_posts`, { fields: "id,scheduled_publish_time", limit: 100 }, token));
  return (r?.data ?? [])
    .map((p) => Number(p.scheduled_publish_time))
    .filter(Boolean)
    .map((s) => new Date(s * 1000 + 5.5 * 3600000).toISOString().slice(0, 10));
};
