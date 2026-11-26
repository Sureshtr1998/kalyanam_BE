import imagekit from "../config/imageKit.js";
import { OpsCreative, OpsPost, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { handle, notice, propose } from "./actions.js";
import { fetchPostPerformance, fetchScheduledDays, igConfigured, publishInstagramPhoto, scheduleFacebookPhoto } from "./meta.js";
import { THEME_NAMES } from "./postDesign.js";
import { devConfigured, dispatchRender } from "./dev.js";

/*
 * Organic posts (never paid), fully automatic. Every Thursday the agent
 * writes next week's posts (one a day at 7:30 pm IST, rotating languages)
 * AND designs their images: each post gets a headline card in its own
 * script (see postDesign.js), rendered by the "Ops render" GitHub Action in
 * Chromium and sent back here. Once a post has its image it is scheduled on
 * Facebook, and published on Instagram at the same time. Nothing needs
 * uploading or approving; every post shows in the calendar with Cancel.
 */

const LANGS = ["Kannada", "Telugu", "Tamil", "Hindi", "Kannada", "Telugu", "English"];

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
        required: ["day", "language", "topic", "kicker", "headline", "subline", "theme", "caption"],
        properties: {
          day: { type: "integer", description: "0 = Monday … 6 = Sunday" },
          language: { type: "string" },
          topic: { type: "string", description: "Short English label for the calendar" },
          kicker: { type: "string", description: "2–4 word label on the image, in the post's language and script" },
          headline: { type: "string", description: "The image's main line, in the post's language and script, max 9 words" },
          subline: { type: "string", description: "One supporting line on the image, max 12 words, same language" },
          theme: { type: "string", enum: THEME_NAMES },
          caption: { type: "string", description: "Caption in the language's own script, under 120 words, 3–6 hashtags, ends with seetharamakalyana.in" },
        },
      },
    },
  },
};

/** Monday 00:00 IST of next week. */
const nextMonday = () => {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const add = ((8 - ist.getUTCDay()) % 7) || 7;
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add));
  return new Date(d.getTime() - 5.5 * 3600000);
};

/** Recent posts ranked by engagement per reach, as short lines for the planner. */
const performanceSummary = (rows) => {
  const scored = rows
    .map((r) => ({ ...r, rate: r.reach ? r.engagement / r.reach : null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.engagement - a.engagement);
  const line = (r) =>
    `[${r.platform} ${String(r.at).slice(0, 10)}] reach ${r.reach ?? "?"}, engagement ${r.engagement}${r.rate != null ? ` (${(r.rate * 100).toFixed(1)}%)` : ""}: "${r.text.replace(/\s+/g, " ").slice(0, 110)}"`;
  return { best: scored.slice(0, 6).map(line), worst: scored.slice(-4).reverse().map(line), count: rows.length };
};

export const planWeek = async () => {
  const config = await getConfig();
  const monday = nextMonday();
  const dayKey = (d) => new Date(monday.getTime() + d * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

  // Only plan days that are still free: nothing from the agent and nothing scheduled in Meta by hand.
  const [ours, manual, performance] = await Promise.all([
    OpsPost.find({ publishAt: { $gte: monday, $lt: new Date(monday.getTime() + 7 * 86400000) }, status: { $ne: "cancelled" } }).lean(),
    fetchScheduledDays().catch(() => []),
    fetchPostPerformance(28).catch(() => []),
  ]);
  const taken = new Set([...ours.map((p) => new Date(p.publishAt.getTime() + 5.5 * 3600000).toISOString().slice(0, 10)), ...manual]);
  const freeDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !taken.has(dayKey(d)));
  if (!freeDays.length) return { skipped: "Every day next week already has a post" };

  const last = await OpsPost.find({ status: { $in: ["published", "scheduled"] } }).sort({ publishAt: -1 }).limit(14).lean();
  const perf = performanceSummary(performance);
  const { posts } = await ask({
    task: "organic.plan",
    tier: "write",
    system: `You plan organic Facebook and Instagram posts for Seetha Rama Kalyana (never ads).
${config.brief}
Each post is a designed text card: a short kicker label, a strong headline and one supporting line, all in the post's language and native script (English posts in English), plus a caption.
Mix through the week: family values, how matching works, safety tips for women meeting a match (general advice only, no promises), success-story style (no real names), festivals that week, and one "why join" post. Vary the themes (${THEME_NAMES.join(", ")}). Headlines must be natural, warm and correct in that language — never a literal translation.
Learn from the performance data: lean towards the topics, languages and angles of the best posts, avoid what the weakest posts did, but keep some variety so new ideas get tested.`,
    prompt: `Plan exactly ${freeDays.length} post(s), only for these days (0 = Monday): ${freeDays.join(", ")}. Day d uses language ${freeDays.map((d) => `${d}=${LANGS[d]}`).join(", ")}.
Week starting ${monday.toDateString()}. The other days already have posts; don't plan them.
Recent agent posts (don't repeat these ideas): ${last.map((p) => `${p.topic} (${p.language})`).join("; ") || "none yet"}.
How the last 4 weeks of posts did (${perf.count} posts; engagement = reactions + comments + shares, or likes + comments on Instagram):
Best: ${perf.best.join("\n") || "no data yet"}
Weakest: ${perf.worst.join("\n") || "no data yet"}`,
    schema: SCHEMA,
    maxTokens: 6000,
  });

  let made = 0;
  for (const p of posts.filter((x) => freeDays.includes(x.day)).slice(0, freeDays.length)) {
    if (taken.has(dayKey(p.day))) continue;
    taken.add(dayKey(p.day));
    const publishAt = new Date(monday.getTime() + p.day * 86400000 + 19.5 * 3600000); // 7:30 pm IST
    await OpsPost.create({
      publishAt,
      language: p.language,
      topic: p.topic,
      caption: p.caption,
      design: { kicker: p.kicker, headline: p.headline, subline: p.subline, theme: p.theme },
      platforms: igConfigured() ? ["facebook", "instagram"] : ["facebook"],
      status: "design",
    });
    made++;
  }
  await requestRenders();
  await notice("organic", {
    type: "organic.week_planned",
    title: `Next week's ${made} post(s) are written; images are being designed`,
    reason: `${7 - freeDays.length ? `${7 - freeDays.length} day(s) already had a post, so they were left alone. ` : ""}Planned using how your last ${perf.count} posts performed. Open Organic or Calendar to see or cancel any of them.`,
    payload: { dedupeKey: `week:${monday.toISOString().slice(0, 10)}` },
  });
  return { planned: made, skippedDays: 7 - freeDays.length, learnedFrom: perf.count };
};

/**
 * Asks the GitHub Action to render posts still waiting for an image.
 * Retries at most 3 times per post, 2 hours apart.
 */
export const requestRenders = async () => {
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
    kind,
    language: p.language,
    kicker: p.design?.kicker,
    headline: p.design?.headline || p.topic,
    subline: p.design?.subline,
    theme: p.design?.theme,
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
  const fb = await scheduleFacebookPhoto(post);
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
  const r = await publishInstagramPhoto(post);
  post.results = { ...post.results, instagramId: r.id };
  post.status = "published";
  await post.save();
  await deletePostImage(post);
  return { instagramId: r.id };
});

/** Marks Facebook-only posts published once their time has passed. */
export const settlePublished = () =>
  OpsPost.updateMany({ status: "scheduled", publishAt: { $lte: new Date() }, platforms: ["facebook"] }, { status: "published" });
