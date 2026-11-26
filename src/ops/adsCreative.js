import imagekit from "../config/imageKit.js";
import { AdSnapshot, OpsAction, OpsCreative, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { Defer, handle, handleUndo, hoursFromNow, propose } from "./actions.js";
import { THEME_NAMES } from "./postDesign.js";
import { copyAd, createCreative, fetchAds, fetchCreativeSpec, graphPost, setStatus, uploadAdImage } from "./meta.js";

/*
 * Fresh creatives for tired ad sets, fully automatic:
 *  1. Find the campaign's best ad (lowest cost per paid member) and the ad
 *     set's weakest active ad.
 *  2. Claude writes two new variants in the campaign's language, modelled on
 *     the best ad's message; their image cards are designed and rendered
 *     like organic posts (Chromium, correct Indic shaping).
 *  3. After the notice period the new ads go live: the best ad is copied
 *     into the ad set (keeping its link, CTA, pixel and settings) with the
 *     new image and text, and the weakest ad is paused.
 * At most once per campaign every 14 days, so ads aren't kept in learning.
 * "Pause / undo" pauses the new ads and restarts the paused one.
 */

const LANGS = ["Kannada", "Telugu", "Tamil", "Hindi", "Marathi", "English"];
export const languageOf = (name = "") => LANGS.find((l) => new RegExp(l, "i").test(name)) ?? "English";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["variants"],
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kicker", "headline", "subline", "theme", "primaryText", "title"],
        properties: {
          kicker: { type: "string", description: "2–4 words on the image, in the language's script" },
          headline: { type: "string", description: "Image headline, max 8 words, same language" },
          subline: { type: "string", description: "One line on the image, max 10 words, same language" },
          theme: { type: "string", enum: THEME_NAMES },
          primaryText: { type: "string", description: "Ad primary text, max 220 characters, same language" },
          title: { type: "string", description: "Ad headline under the image, max 40 characters, same language" },
        },
      },
    },
  },
};

/** Ad performance over the last 14 days, keyed by ad id. */
const adStats = async () => {
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const rows = await AdSnapshot.aggregate([
    { $match: { level: "ad", date: { $gte: since } } },
    { $group: { _id: "$entityId", name: { $first: "$name" }, spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
  ]);
  return new Map(rows.map((r) => [r._id, r]));
};
const cpp = (s) => (s?.paid ? s.spend / s.paid : Infinity);

/**
 * Plans a creative refresh for one tired unit (campaign or ad set).
 * Returns the proposed action, or a reason it was skipped.
 */
export const planCreativeRefresh = async (unit) => {
  const config = await getConfig();
  const campaignId = unit.level === "campaign" ? unit.id : unit.campaignId;
  const recent = await OpsAction.findOne({
    type: "ads.creative_launch",
    "payload.campaignId": campaignId,
    status: { $in: ["scheduled", "shadow", "done", "running"] },
    createdAt: { $gte: new Date(Date.now() - 14 * 86400000) },
  });
  if (recent) return { skipped: "Creatives for this campaign changed in the last 14 days" };

  const [ads, stats] = await Promise.all([fetchAds(), adStats()]);
  const active = ads.filter((a) => a.campaign_id === campaignId && a.effective_status === "ACTIVE");
  if (!active.length) return { skipped: "No active ads in this campaign" };

  // Target ad set: the tired one itself, or the campaign's ad set with the highest frequency.
  let adsetId = unit.level === "adset" ? unit.id : null;
  if (!adsetId) {
    const latest = await AdSnapshot.find({ level: "adset", campaignId, frequency7: { $ne: null } }).sort({ date: -1, frequency7: -1 }).limit(1).lean();
    adsetId = latest[0]?.entityId ?? active[0].adset_id;
  }
  const base = [...active].filter((a) => (stats.get(a.id)?.paid ?? 0) >= 2).sort((a, b) => cpp(stats.get(a.id)) - cpp(stats.get(b.id)))[0] ?? active[0];
  const inSet = active.filter((a) => a.adset_id === adsetId && a.id !== base.id);
  const worst = inSet.filter((a) => (stats.get(a.id)?.spend ?? 0) >= 300).sort((a, b) => cpp(stats.get(b.id)) - cpp(stats.get(a.id)))[0] ?? null;

  const spec = await fetchCreativeSpec(base.id).catch(() => null);
  const link = spec?.object_story_spec?.link_data;
  const language = languageOf(unit.name);

  const { variants } = await ask({
    task: "ads.creatives",
    tier: "ads",
    system: `You write Meta ad creatives for Seetha Rama Kalyana, a matrimony site for families.
${config.brief}
Write in the given language and its native script (English only if the language is English), natural and warm, never a literal translation.
Model the new ads on the winning ad's angle but say it differently. Never name competitors, never promise matches or safety beyond the brief, no fake urgency, no reference prices.`,
    prompt: `Campaign: ${unit.name} (language: ${language}).
Why: ${unit.notes?.join(" ") || "the same people keep seeing the same ads"}.
Winning ad "${base.name}" (cost per paid member ₹${Number.isFinite(cpp(stats.get(base.id))) ? Math.round(cpp(stats.get(base.id))) : "?"}):
text: ${link?.message ?? "(unknown)"}
headline: ${link?.name ?? "(unknown)"}
Write 2 new variants.`,
    schema: SCHEMA,
    maxTokens: 12000,
  });

  const created = [];
  for (const v of variants.slice(0, 2)) {
    created.push(
      await OpsCreative.create({
        campaignId,
        campaignName: unit.name,
        adsetId,
        language,
        baseAdId: base.id,
        replaceAdId: worst?.id,
        design: { kicker: v.kicker, headline: v.headline, subline: v.subline, theme: v.theme },
        primaryText: v.primaryText,
        title: v.title,
      })
    );
  }
  const action = await propose(
    "ads",
    {
      type: "ads.creative_launch",
      title: `2 fresh ads for ${unit.name}`,
      reason: `${unit.notes?.join(" ") || "Ad fatigue."} New versions of the best ad "${base.name}"${worst ? `; the weakest ad "${worst.name}" gets paused` : ""}. Headlines: “${variants.map((v) => v.headline).join("”, “")}”.`,
      effect: `Copies "${base.name}" into the ad set twice with the new images and text, starts them, ${worst ? `pauses "${worst.name}"` : "pauses nothing"}. The ad set re-learns for ~3 days.`,
      payload: { campaignId, adsetId, creativeIds: created.map((c) => String(c._id)), baseAdId: base.id, replaceAdId: worst?.id ?? null },
      ref: { kind: "meta", id: `creative:${campaignId}` },
      runAt: hoursFromNow(config.limits.adNoticeHours),
    },
    { dedupeKey: `ads.creative_launch:${campaignId}` }
  );
  return { action: action?._id ?? null, creatives: created.length };
};

const toBase64 = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Couldn't fetch the ad image (${res.status})`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
};

handle("ads.creative_launch", async (action) => {
  const p = action.payload;
  const creatives = await OpsCreative.find({ _id: { $in: p.creativeIds } });
  if (creatives.some((c) => c.status === "design")) {
    if ((p.deferrals ?? 0) >= 6) throw new Error("The ad images were never designed. Check the Ops render GitHub Action.");
    throw new Defer("Waiting for the ad images to be designed; trying again in 2 hours.");
  }
  const spec = await fetchCreativeSpec(p.baseAdId);
  const story = spec?.object_story_spec;
  if (!story?.link_data) {
    throw new Error("The best ad uses a format the agent can't copy (e.g. flexible or catalogue). The new images are in Ops → Ads; add them by hand.");
  }
  const adIds = [];
  for (const c of creatives.filter((x) => x.status === "ready")) {
    const hash = await uploadAdImage(await toBase64(c.imageUrl), `ops-${c._id}.jpg`);
    const linkData = { ...story.link_data, image_hash: hash, message: c.primaryText, name: c.title };
    delete linkData.picture;
    delete linkData.child_attachments;
    const creative = await createCreative({
      name: `Ops | ${c.language} | ${c.design.headline}`.slice(0, 100),
      object_story_spec: { ...story, link_data: linkData },
      ...(spec.url_tags ? { url_tags: spec.url_tags } : {}),
      ...(spec.degrees_of_freedom_spec ? { degrees_of_freedom_spec: spec.degrees_of_freedom_spec } : {}),
    });
    const adId = await copyAd(p.baseAdId, p.adsetId);
    if (!adId) throw new Error("Meta didn't return the copied ad");
    await graphPost(adId, { creative: { creative_id: creative.id }, name: `${c.language}-OPS ${c.design.headline}`.slice(0, 100) });
    await setStatus(adId, "ACTIVE");
    c.adId = adId;
    c.status = "live";
    await c.save();
    adIds.push(adId);
    if (c.imageFileId) await imagekit.deleteFile(c.imageFileId).catch(() => {});
  }
  if (p.replaceAdId) await setStatus(p.replaceAdId, "PAUSED");
  return { adIds, paused: p.replaceAdId ?? null };
});

handleUndo("ads.creative_launch", async (action) => {
  for (const id of action.result?.adIds ?? []) await setStatus(id, "PAUSED");
  if (action.result?.paused) await setStatus(action.result.paused, "ACTIVE");
});

/**
 * New ads from given copy (an owner's idea): adds them next to the existing
 * ads, copying the campaign's best ad for link, CTA and tracking. Nothing is
 * paused. Returns the proposed action.
 */
export const proposeIdeaCreatives = async ({ campaignId, campaignName, adsetId, language, variants, runAt, reason, ideaId }) => {
  const [ads, stats] = await Promise.all([fetchAds(), adStats()]);
  const active = ads.filter((a) => a.campaign_id === campaignId && a.effective_status === "ACTIVE");
  if (!active.length) throw new Error(`No active ads in ${campaignName} to copy the setup from`);
  const base = [...active].filter((a) => (stats.get(a.id)?.paid ?? 0) >= 2).sort((a, b) => cpp(stats.get(a.id)) - cpp(stats.get(b.id)))[0] ?? active[0];
  const target = adsetId && active.some((a) => a.adset_id === adsetId) ? adsetId : base.adset_id;
  const created = [];
  for (const v of variants.slice(0, 3)) {
    created.push(
      await OpsCreative.create({
        campaignId,
        campaignName,
        adsetId: target,
        language,
        baseAdId: base.id,
        design: { kicker: v.kicker, headline: v.headline, subline: v.subline, theme: v.theme },
        primaryText: v.primaryText,
        title: v.title,
      })
    );
  }
  return propose(
    "ads",
    {
      type: "ads.creative_launch",
      title: `${created.length} new ad${created.length > 1 ? "s" : ""} for ${campaignName}`,
      reason: `${reason} Headlines: “${variants.map((v) => v.headline).join("”, “")}”.`,
      effect: `Copies "${base.name}" (link, button, tracking) with the new images and text and starts ${created.length > 1 ? "them" : "it"} next to the current ads. Nothing is paused.`,
      payload: { campaignId, adsetId: target, creativeIds: created.map((c) => String(c._id)), baseAdId: base.id, replaceAdId: null, ideaId },
      ref: { kind: "meta", id: `idea-creative:${ideaId}:${campaignId}` },
      runAt,
    }
  );
};
