import imagekit from "../config/imageKit.js";
import User from "../models/User.js";
import { OpsCreative, OpsPost, OpsReport, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { handle, notice, propose } from "./actions.js";
import { fetchPostPerformance, fetchScheduledTimes, igConfigured, publishInstagramPhoto, scheduleFacebookPhoto } from "./meta.js";
import { THEME_NAMES } from "./postDesign.js";
import { devConfigured, dispatchRender } from "./dev.js";
import { CLAIM_RULES } from "./adsCreative.js";
import { IDEAS, IDEA_KEYS, bridesShare, familyDoubts, loadIdeaLibrary } from "./adsIdeas.js";
import { codeSource, postCode, shortUrl, trackedLink } from "./links.js";

/*
 * Organic posts (never paid, never boosted), fully automatic, with one goal:
 * registrations. Every Thursday the agent writes next week's posts for the
 * evenings that are still free (7:30 pm IST, languages rotating so all five
 * get equal turns) and designs their images in each post's own script:
 *  - "join" posts use the layout of the cheapest ads (pill, two-line
 *    headline, three ticks, price, button), at most 1 in 3 posts;
 *  - "card" posts (trust, how it works, community, festivals) use the
 *    mandala card.
 * Facebook captions end with a clickable link to the post's language page
 * carrying a tracking code (?p=fkn1127); Instagram captions say "link in
 * bio" and show the short address. Sign-ups from each code are counted
 * (User.acquisition), and the next week's plan learns from sign-ups first,
 * then link clicks, then engagement. The rules are written out in the
 * "organic-playbook" skill; keep the two in step.
 */

/** Languages get equal turns: the rotation carries on from week to week. */
const ROTATION = ["Kannada", "Telugu", "Tamil", "Hindi", "English"];
export const languageForDay = (monday, day) => ROTATION[(Math.floor(monday.getTime() / (7 * 86400000)) * 7 + day) % ROTATION.length];

/** Posts at 7:30 pm IST; an evening counts as taken if anything is scheduled 5:30–10:30 pm. */
const POST_HOUR = 19.5;
const EVENING = [17.5, 22.5];

/** The facts and promises posts may use (safety promises from the Terms, 17 Nov 2026). */
const SAFETY_PROMISES = `Safety promises you may use (nothing beyond these): members who misuse the site are removed permanently with no refund; anyone can report misuse any time, day or night, to contactus@seetharamakalyana.in; reports are reviewed within 24 hours and kept confidential; for crimes, the national Cyber Crime helpline is 1930.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["posts"],
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "language", "idea", "format", "angle", "topic", "kicker", "headline", "subline", "highlight", "bullets", "price", "cta", "caption", "hashtags", "theme"],
        properties: {
          day: { type: "integer", description: "0 = Monday … 6 = Sunday" },
          idea: { type: "string", enum: IDEA_KEYS, description: "The idea this post carries" },
          language: { type: "string" },
          format: { type: "string", enum: ["join", "card"], description: "join = direct reasons to register (ad layout); card = trust/value post" },
          angle: { type: "string", description: "One English line: which angle and why it should bring sign-ups" },
          topic: { type: "string", description: "Short English label for the calendar" },
          kicker: { type: "string", description: "Pill/label on the image, max 6 words, in the post's language and script" },
          headline: { type: "string", description: "Main line on the image, max 8 words (join: line 1 of 2)" },
          subline: { type: "string", description: "card: one supporting line, max 12 words. join: empty" },
          highlight: { type: "string", description: "join: headline line 2 (the punchline), max 5 words. card: empty" },
          bullets: { type: "array", items: { type: "string" }, description: "join: exactly 3 ticks, max 7 words each. card: empty" },
          price: { type: "string", description: "join: price line, e.g. '₹351 a year' in the language. card: empty" },
          cta: { type: "string", description: "Call to register in the post's language, max 6 words, no link (the link is added per platform)" },
          caption: {
            type: "string",
            description: "Caption body in the post's language and script, under 90 words: line 1 is a hook (a question or a worry families have, max 12 words), then 2–4 short lines of value. No link, no hashtags.",
          },
          hashtags: { type: "array", items: { type: "string" }, description: "5–8 hashtags without #, e.g. KannadaMatrimony, the community, the city" },
          theme: { type: "string", enum: THEME_NAMES, description: "card posts only" },
        },
      },
    },
  },
};

/** The quality check's answer for posts: claims and language, with a fixed version when it can be saved. */
const FIXED_POST = {
  type: "object",
  additionalProperties: false,
  required: ["kicker", "headline", "subline", "highlight", "bullets", "price", "cta", "caption"],
  properties: {
    kicker: { type: "string" },
    headline: { type: "string" },
    subline: { type: "string" },
    highlight: { type: "string" },
    bullets: { type: "array", items: { type: "string" } },
    price: { type: "string" },
    cta: { type: "string" },
    caption: { type: "string" },
  },
};
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reviews"],
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "claimsOk", "languageOk", "problems", "fixed"],
        properties: {
          index: { type: "integer" },
          claimsOk: { type: "boolean" },
          languageOk: { type: "boolean" },
          problems: { type: "array", items: { type: "string" } },
          fixed: { anyOf: [FIXED_POST, { type: "null" }] },
        },
      },
    },
  },
};

/** Second pass on the week's posts (Sonnet): every claim must be allowed and the language natural; fixes or drops. */
export const reviewPosts = async (posts, config) => {
  const { reviews } = await ask({
    task: "organic.review",
    tier: "write",
    system: `You check organic Facebook and Instagram posts for Seetha Rama Kalyana before they are scheduled. Be strict.
${config.brief}
${CLAIM_RULES}
${SAFETY_PROMISES}
claimsOk is false if any line states or implies something outside the allowed facts and promises. languageOk is false if the text is unnatural, wrong or a literal translation for its language.
When something is wrong and can be fixed without changing the idea, return a fixed version (same language); otherwise fixed is null.`,
    prompt: posts.map((p, i) => `Post ${i} (${p.language}):\n${JSON.stringify({ kicker: p.kicker, headline: p.headline, subline: p.subline, highlight: p.highlight, bullets: p.bullets, price: p.price, cta: p.cta, caption: p.caption })}`).join("\n\n"),
    schema: REVIEW_SCHEMA,
    maxTokens: 10000,
  });
  const kept = [];
  for (const [i, p] of posts.entries()) {
    const r = reviews.find((x) => x.index === i);
    if (!r || (r.claimsOk && r.languageOk)) kept.push({ ...p, review: "Passed the claims and language check." });
    else if (r.fixed) kept.push({ ...p, ...r.fixed, review: `Fixed by the check: ${r.problems.join("; ")}` });
  }
  return { kept, dropped: posts.length - kept.length };
};

/** Which ideas bring members cheapest in paid ads, per language (message learning only; posts never become ads). */
const adIdeaLines = (library, languages) =>
  languages
    .map((lang) => {
      const rows = library.filter((r) => r.language === lang && r.paid >= 5 && r.idea !== "other").sort((a, b) => a.cpp - b.cpp).slice(0, 3);
      return rows.length ? `${lang}: ${rows.map((r) => `${IDEAS[r.idea]?.label ?? r.idea} (${r.audience}, ₹${Math.round(r.cpp)}/member)`).join(", ")}` : null;
    })
    .filter(Boolean);

/** Monday 00:00 IST of next week. */
const nextMonday = () => {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const add = ((8 - ist.getUTCDay()) % 7) || 7;
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add));
  return new Date(d.getTime() - 5.5 * 3600000);
};

const istHour = (d) => {
  const t = new Date(new Date(d).getTime() + 5.5 * 3600000);
  return t.getUTCHours() + t.getUTCMinutes() / 60;
};
const istDay = (d) => new Date(new Date(d).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

/** Sign-ups per organic tracking code (User.acquisition), last `days` days. */
export const organicSignups = async (days = 28) => {
  const rows = await User.aggregate([
    { $match: { createdAt: { $gte: new Date(Date.now() - days * 86400000) }, "acquisition.utmMedium": "organic" } },
    { $group: { _id: { $toLower: "$acquisition.utmContent" }, n: { $sum: 1 } } },
  ]);
  return new Map(rows.filter((r) => r._id).map((r) => [r._id, r.n]));
};

/**
 * Ranks recent posts for the planner: sign-ups first, then link clicks per
 * reach, then engagement per reach. Returns short lines.
 */
export const performanceSummary = (rows, signups = new Map()) => {
  const scored = rows.map((r) => ({
    ...r,
    signups: r.code ? signups.get(r.code) ?? 0 : null,
    clickRate: r.reach && r.linkClicks != null ? r.linkClicks / r.reach : null,
    rate: r.reach ? r.engagement / r.reach : null,
  }));
  scored.sort(
    (a, b) => (b.signups ?? -1) - (a.signups ?? -1) || (b.clickRate ?? -1) - (a.clickRate ?? -1) || (b.rate ?? -1) - (a.rate ?? -1) || b.engagement - a.engagement
  );
  const line = (r) =>
    `[${r.platform} ${String(r.at).slice(0, 10)}${r.format ? ` ${String(r.format).toLowerCase()}` : ""}] ` +
    `${r.idea ? `idea ${r.idea}, ` : ""}${r.signups != null ? `${r.signups} sign-ups, ` : ""}reach ${r.reach ?? "?"}, engagement ${r.engagement}` +
    `${r.linkClicks != null ? `, link clicks ${r.linkClicks}` : ""}${r.profileVisits != null ? `, profile visits ${r.profileVisits}` : ""}: ` +
    `"${r.text.replace(/\s+/g, " ").slice(0, 110)}"`;
  return {
    best: scored.slice(0, 6).map(line),
    worst: scored.slice(-4).reverse().map(line),
    count: rows.length,
    signups: [...signups.values()].reduce((t, n) => t + n, 0),
  };
};

/** The caption as posted: body, call to register with the link for that platform, hashtags. */
export const captionFor = (post, platform) => {
  // Older posts carry their own link and hashtags in the caption.
  if (!post.cta) return post.caption;
  const tags = (post.hashtags ?? []).map((t) => `#${String(t).replace(/^#/, "").replace(/\s+/g, "")}`);
  const facebook = platform === "facebook";
  const link = facebook ? trackedLink(post.language, `f${post.code}`) : `${shortUrl(post.language)} (link in bio)`;
  return [String(post.caption).trim(), "", `${post.cta}: ${link}`, "", (facebook ? tags.slice(0, 3) : tags.slice(0, 8)).join(" ")].join("\n").trim();
};

export const planWeek = async () => {
  const config = await getConfig();
  const monday = nextMonday();
  const dayKey = (d) => istDay(new Date(monday.getTime() + d * 86400000));

  // Only plan evenings that are still free: nothing from the agent and nothing scheduled in Meta by hand that evening.
  const [ours, manual, performance, signups, doubts, brides, library, tagged] = await Promise.all([
    OpsPost.find({ publishAt: { $gte: monday, $lt: new Date(monday.getTime() + 7 * 86400000) }, status: { $nin: ["cancelled", "failed"] } }).lean(),
    fetchScheduledTimes().catch(() => []),
    fetchPostPerformance(28).catch(() => []),
    organicSignups(28).catch(() => new Map()),
    familyDoubts().catch(() => []),
    bridesShare().catch(() => null),
    loadIdeaLibrary(60).catch(() => []),
    OpsPost.find({ code: { $ne: null }, idea: { $ne: null } }).select("code idea").lean(),
  ]);
  // The agent's own posts carry their idea, so results build up per idea.
  const ideaByCode = new Map(tagged.map((p) => [p.code, p.idea]));
  for (const r of performance) if (r.code) r.idea = ideaByCode.get(r.code.slice(1));
  const taken = new Set([
    ...ours.map((p) => istDay(p.publishAt)),
    ...manual.filter((t) => istHour(t) >= EVENING[0] && istHour(t) <= EVENING[1]).map(istDay),
  ]);
  const freeDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !taken.has(dayKey(d)));
  if (!freeDays.length) return { skipped: "Every evening next week already has a post" };
  const maxJoin = Math.max(1, Math.floor(freeDays.length / 3));

  const last = await OpsPost.find({ status: { $in: ["published", "scheduled"] } }).sort({ publishAt: -1 }).limit(14).lean();
  const perf = performanceSummary(performance, signups);
  const { posts } = await ask({
    task: "organic.plan",
    tier: "write",
    system: `You plan organic Facebook and Instagram posts for Seetha Rama Kalyana. They are never ads and never boosted.
${config.brief}
${CLAIM_RULES}
${SAFETY_PROMISES}
The goal is registrations: every post must stop a family's scroll, answer a doubt they have, and invite them to sign up.
Formats:
- "join": the layout of the cheapest ads (pill, two-line headline, three ticks, price line, button). Direct reasons to register. At most ${maxJoin} this week.
- "card": a headline card (kicker, headline, supporting line). Trust and value posts.
Ideas (each post carries one; rotate them and lean towards what brought sign-ups, below):
${IDEA_KEYS.map((k) => `- ${k} (${IDEAS[k].label}): ${IDEAS[k].hint}`).join("\n")}
Rules for the mix:
- At least one post speaks to brides' families (daughters' parents).
- When families' questions are listed below, at least one post uses the "answer" idea to answer one of them plainly, in the families' own words.
- A festival or auspicious day only if you are sure it falls in that week for that region; no hard call to register on Amavasya or mourning days.
Writing:
- Each post entirely in its language and native script (English posts in English): natural and warm, never a literal translation.
- The caption's first line is the hook. Keep lines short; families read on phones.
- The cta is a short invite in the post's language (e.g. "Register today · ₹351 a year"); the link is added for you.
- Hashtags: language + matrimony, community, region or city. No generic spam tags.`,
    prompt: `Plan exactly ${freeDays.length} post(s), only for these days (0 = Monday): ${freeDays.join(", ")}. Languages: ${freeDays.map((d) => `${d}=${languageForDay(monday, d)}`).join(", ")}.
Week starting ${monday.toDateString()}. The other evenings already have posts; don't plan them.
Recent agent posts (don't repeat these ideas): ${last.map((p) => `${p.topic} (${p.language}${p.format === "join" ? ", join" : ""})`).join("; ") || "none yet"}.
How the last 4 weeks of posts did (${perf.count} posts, ${perf.signups} sign-ups traced to post links). They are ranked by sign-ups, then link clicks per reach, then engagement per reach. On Instagram, links can't be clicked, so profile visits show interest:
Best: ${perf.best.join("\n") || "no data yet"}
Weakest: ${perf.worst.join("\n") || "no data yet"}
Which ideas bring members cheapest in paid ads, by language (learn the message; never copy an ad):
${adIdeaLines(library, [...new Set(freeDays.map((d) => languageForDay(monday, d)))]).join("\n") || "- not enough ad data yet"}
What families asked or doubted in the last 14 days (comments and support mail):
${doubts.slice(0, 15).join("\n") || "- nothing recorded"}
${brides ? `Brides are ${Math.round(brides.share * 100)}% of new members (${brides.women} of ${brides.total} in 14 days).` : ""}`,
    schema: SCHEMA,
    maxTokens: 8000,
  });
  // Quality check before anything is designed or scheduled.
  const checked = await reviewPosts(posts.filter((x) => freeDays.includes(x.day)).slice(0, freeDays.length), config);

  let made = 0;
  let joins = 0;
  for (const p of checked.kept) {
    if (taken.has(dayKey(p.day))) continue;
    taken.add(dayKey(p.day));
    const join = p.format === "join" && joins < maxJoin;
    if (join) joins++;
    const publishAt = new Date(monday.getTime() + p.day * 86400000 + POST_HOUR * 3600000);
    const language = languageForDay(monday, p.day);
    await OpsPost.create({
      publishAt,
      language,
      topic: p.topic,
      angle: p.angle,
      idea: IDEA_KEYS.includes(p.idea) ? p.idea : undefined,
      review: p.review,
      format: join ? "join" : "card",
      caption: p.caption,
      cta: p.cta,
      hashtags: p.hashtags.slice(0, 8),
      code: postCode(language, publishAt),
      design: join
        ? { kicker: p.kicker, headline: p.headline, highlight: p.highlight, bullets: p.bullets.slice(0, 3), price: p.price, cta: p.cta, theme: "ad" }
        : { kicker: p.kicker, headline: p.headline, subline: p.subline, theme: p.theme },
      platforms: igConfigured() ? ["facebook", "instagram"] : ["facebook"],
      status: "design",
    });
    made++;
  }
  await requestRenders();
  await notice("organic", {
    type: "organic.week_planned",
    title: `Next week's ${made} post(s) are written; images are being designed`,
    reason: `${7 - freeDays.length ? `${7 - freeDays.length} evening(s) already had a post, so they were left alone. ` : ""}${checked.dropped ? `The quality check dropped ${checked.dropped} post(s). ` : ""}${joins} "join" post(s), the rest trust and value posts. Planned from how your last ${perf.count} posts did (${perf.signups} sign-ups traced to post links). Open Organic or Calendar to see or cancel any of them.`,
    payload: { dedupeKey: `week:${monday.toISOString().slice(0, 10)}` },
  });
  return { planned: made, joins, dropped: checked.dropped, skippedDays: 7 - freeDays.length, learnedFrom: perf.count };
};

/**
 * Re-plans next week: cancels the agent's posts that are still waiting for
 * their image (nothing has been scheduled in Meta for them yet) and plans
 * the week again with the current planner. Posts already scheduled, and
 * anything posted by hand, are left alone.
 */
export const replanWeek = async () => {
  const monday = nextMonday();
  const { modifiedCount } = await OpsPost.updateMany(
    { publishAt: { $gte: monday, $lt: new Date(monday.getTime() + 7 * 86400000) }, status: { $in: ["design", "failed"] } },
    { $set: { status: "cancelled", error: "Re-planned" } }
  );
  const result = await planWeek();
  return { cancelled: modifiedCount, ...result };
};

/**
 * Daily: stores how organic posts did and the sign-ups traced to them, for
 * the Organic screen and for Claude Code's /weekly-posts (read via the Ops API).
 */
export const recordOrganicStats = async () => {
  const [performance, signups] = await Promise.all([fetchPostPerformance(28), organicSignups(28)]);
  const posts = performance.map((p) => ({ ...p, signups: p.code ? signups.get(p.code) ?? 0 : null }));
  const totals = { facebook: 0, instagram: 0, bio: signups.get("bio") ?? 0, total: 0 };
  for (const [code, n] of signups) {
    totals.total += n;
    if (code !== "bio") totals[codeSource(code)] += n;
  }
  const today = istDay(new Date());
  await OpsReport.updateOne(
    { kind: "organic", period: today },
    { $set: { kind: "organic", period: today, body: "", data: { posts, totals, codes: Object.fromEntries(signups) } } },
    { upsert: true }
  );
  return { posts: posts.length, signups: totals.total };
};

/**
 * Asks the GitHub Action to render posts still waiting for an image.
 * Retries at most 3 times per post, 2 hours apart.
 */
export const requestRenders = async () => {
  // Images that failed 3 times: the post or ad is marked failed (freeing its day for the planner) and the owner is told.
  const giveUp = { status: "design", renderRequests: { $gte: 3 }, renderRequestedAt: { $lte: new Date(Date.now() - 2 * 3600000) } };
  const [deadPosts, deadAds] = await Promise.all([OpsPost.countDocuments(giveUp), OpsCreative.countDocuments(giveUp)]);
  if (deadPosts + deadAds) {
    const error = "The image couldn't be designed after 3 tries (Ops render GitHub Action).";
    await OpsPost.updateMany(giveUp, { $set: { status: "failed", error } });
    await OpsCreative.updateMany(giveUp, { $set: { status: "failed" } });
    await notice("organic", {
      type: "organic.render_failed",
      priority: "urgent",
      title: `${deadPosts + deadAds} image(s) couldn't be designed`,
      reason: "The Ops render GitHub Action failed 3 times for them. Check github.com → kalyanam_BE → Actions → Ops render. Failed posts free their day; next week's plan fills it again.",
      effect: "Alert only.",
      payload: { dedupeKey: `render_failed:${new Date().toISOString().slice(0, 10)}` },
    });
  }
  const due = {
    status: "design",
    renderRequests: { $lt: 3 },
    $or: [{ renderRequestedAt: null }, { renderRequestedAt: { $lte: new Date(Date.now() - 2 * 3600000) } }],
  };
  const [posts, creatives] = await Promise.all([OpsPost.find(due).select("_id").lean(), OpsCreative.find(due).select("_id").lean()]);
  const waiting = [...posts, ...creatives];
  if (!waiting.length) return 0;
  if (!devConfigured()) {
    await notice("organic", {
      type: "organic.render_blocked",
      priority: "urgent",
      title: "Post images can't be designed: GitHub isn't connected",
      reason: "Set GITHUB_TOKEN on the server, and BASE_URL + INTERNAL_ROUTE_SECRET as secrets in the kalyanam_BE GitHub repo.",
      payload: { dedupeKey: `render_blocked:${new Date().toISOString().slice(0, 10)}` },
    });
    return 0;
  }
  await dispatchRender();
  const bump = { $inc: { renderRequests: 1 }, $set: { renderRequestedAt: new Date() } };
  await OpsPost.updateMany({ _id: { $in: posts.map((p) => p._id) } }, bump);
  await OpsCreative.updateMany({ _id: { $in: creatives.map((p) => p._id) } }, bump);
  return waiting.length;
};

/** Organic posts and ad creatives the render Action should draw. */
export const renderQueue = async () => {
  const card = (kind) => (p) => ({
    _id: String(p._id),
    // Organic "join" posts are drawn in the ad layout too.
    kind: kind === "post" && p.format === "join" ? "ad" : kind,
    language: p.language,
    // The short address printed on the card, in the post's language (people type it from Instagram).
    url: kind === "post" ? shortUrl(p.language) : undefined,
    kicker: p.design?.kicker,
    headline: p.design?.headline || p.topic,
    subline: p.design?.subline,
    theme: p.design?.theme,
    // Ad cards only.
    highlight: p.design?.highlight,
    bullets: p.design?.bullets,
    price: p.design?.price,
    cta: p.design?.cta,
  });
  const [posts, creatives] = await Promise.all([
    OpsPost.find({ status: "design" }).sort({ publishAt: 1 }).limit(14).lean(),
    OpsCreative.find({ status: "design" }).sort({ createdAt: 1 }).limit(10).lean(),
  ]);
  return [...posts.map(card("post")), ...creatives.map(card("ad"))];
};

/** Stores a rendered ad image; the launch action picks it up. */
const creativeRendered = async (creative, jpegBase64) => {
  if (creative.status !== "design") return { skipped: creative.status };
  const up = await imagekit.upload({
    file: jpegBase64,
    fileName: `ad-${String(creative.language).toLowerCase()}-${creative._id}.jpg`,
    folder: process.env.OPS_AD_FOLDER || "/ops-ads",
    useUniqueFileName: true,
  });
  creative.imageUrl = up.url;
  creative.imageFileId = up.fileId;
  creative.status = "ready";
  await creative.save();
  return { imageUrl: up.url };
};

/** Stores a rendered image and schedules the post. */
export const renderDone = async (postId, jpegBase64) => {
  const post = await OpsPost.findById(postId);
  if (!post) {
    const creative = await OpsCreative.findById(postId);
    if (creative) return creativeRendered(creative, jpegBase64);
    throw Object.assign(new Error("Post not found"), { status: 404 });
  }
  if (post.status !== "design") return { skipped: post.status };
  const up = await imagekit.upload({
    file: jpegBase64,
    fileName: `post-${post.publishAt.toISOString().slice(0, 10)}-${String(post.language).toLowerCase().split(" ")[0]}.jpg`,
    folder: process.env.OPS_POST_FOLDER || "/ops-posts",
    useUniqueFileName: true,
  });
  post.imageUrl = up.url;
  post.imageFileId = up.fileId;
  post.status = "planned";
  await post.save();
  await propose("organic", {
    type: "organic.schedule",
    title: `${post.publishAt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })} · ${post.language}: ${post.topic}`,
    reason: "Weekly organic plan; image designed by the agent.",
    effect: "Schedules the Facebook post now; Instagram publishes at the same time.",
    payload: { postId: String(post._id) },
    ref: { kind: "post", id: String(post._id) },
    runAt: new Date(),
  });
  return { imageUrl: up.url };
};

/**
 * Removes a post's image from ImageKit once Meta has copied it: Facebook
 * copies when the post is scheduled, Instagram when it publishes.
 */
export const deletePostImage = async (post) => {
  if (!post.imageFileId) return;
  try {
    await imagekit.deleteFile(post.imageFileId);
  } catch (err) {
    console.error("[ops] image delete", err.message);
    return;
  }
  post.imageFileId = undefined;
  post.imageUrl = undefined;
  post.imageDeletedAt = new Date();
  await post.save();
};

handle("organic.schedule", async (action) => {
  const post = await OpsPost.findById(action.payload.postId);
  if (!post || post.status === "cancelled") return { skipped: true };
  if (!post.imageUrl) throw new Error("The post has no image yet");
  const fb = await scheduleFacebookPhoto({ imageUrl: post.imageUrl, publishAt: post.publishAt, caption: captionFor(post, "facebook") });
  post.results = { ...post.results, facebookId: fb.id };
  post.status = "scheduled";
  await post.save();
  if (!post.platforms.includes("instagram")) await deletePostImage(post);
  if (post.platforms.includes("instagram")) {
    await propose("organic", {
      type: "organic.publish_ig",
      title: `Instagram: ${post.topic}`,
      reason: "Instagram's API can't schedule, so the agent posts it at the planned time.",
      effect: "Publishes the photo and caption on Instagram.",
      payload: { postId: String(post._id) },
      ref: { kind: "post-ig", id: String(post._id) },
      runAt: post.publishAt,
    });
  }
  return { facebookId: fb.id };
});

handle("organic.publish_ig", async (action) => {
  const post = await OpsPost.findById(action.payload.postId);
  if (!post || post.status === "cancelled") return { skipped: true };
  const r = await publishInstagramPhoto({ imageUrl: post.imageUrl, caption: captionFor(post, "instagram") });
  post.results = { ...post.results, instagramId: r.id };
  post.status = "published";
  await post.save();
  await deletePostImage(post);
  return { instagramId: r.id };
});

/** Marks Facebook-only posts published once their time has passed. */
export const settlePublished = () =>
  OpsPost.updateMany({ status: "scheduled", publishAt: { $lte: new Date() }, platforms: ["facebook"] }, { status: "published" });
