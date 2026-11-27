import imagekit from "../config/imageKit.js";
import { AdSnapshot, OpsAction, OpsCreative, getConfig } from "./models.js";
import { ask } from "./claude.js";
import { Defer, handle, handleUndo, notice, propose } from "./actions.js";
import { RULES, languageOf } from "./adsEngine.js";
import { langPath } from "./links.js";
import { calendarNotes } from "./hinduCalendar.js";
import { copyAd, createCreative, fetchAdImage, fetchAds, fetchCreativeSpec, graphDelete, graphGet, graphPost, metaErrorText, setStatus, uploadAdImage } from "./meta.js";
import { IDEAS, IDEA_KEYS, audienceOf, bridesShare, familyDoubts, ideaFacts, ideaOf, ideaTarget, loadIdeaLibrary, loadOwnerIdeas, organicWinners, pickIdeas } from "./adsIdeas.js";

export { languageOf, audienceOf };

/*
 * Fresh ads for an ad set, fully automatic (planned on batch days, see
 * adsGrowth.js):
 *  1. The ad set's audience comes from its name (Parents 45-65, Young 24-34).
 *  2. The idea engine (adsIdeas.js) picks the ideas: one PROVEN idea for
 *     this language and audience, one TEST of the most promising untried one.
 *  3. Claude (Opus) sees the best and worst ads' actual images and numbers,
 *     families' own questions, the brides' share, the season and organic
 *     winners' messages, and writes one variant per idea, in the campaign's
 *     language, with an English translation for the owner.
 *  4. A second Claude pass (Sonnet) checks every claim against the allowed
 *     list and the language's naturalness; it fixes or drops bad variants.
 *  3. The cards are drawn in the winning ads' layout (postDesign.adHtml),
 *     rendered by Chromium in the "Ops render" GitHub Action.
 *  4. After the notice period each variant goes live as a copy of the ad
 *     set's best ad (link, button, pixel) with the new image and text and
 *     its own utm_content, so its joins can be told apart.
 * Weak ads are paused separately (ads.pause_ad), in the same batch.
 * "Pause / undo" pauses the new ads again.
 */

const CODES = { Kannada: "kn", Telugu: "te", Tamil: "ta", Hindi: "hi", Marathi: "mr", English: "en" };

/** What new ads may and may not say. Read together with the editable brief. */
export const CLAIM_RULES = `Facts you may use (nothing else):
- Membership is ₹351 a year. Paid sign-up keeps casual browsers away ("marriage isn't time-pass").
- Email and mobile number are OTP-verified (that is what the verified badge means).
- No agents or brokers, no sales calls.
- Matches within your language and community (caste, sub-caste), gothra; horoscope matching is available.
- Communities may be named, but only these (all checked against the site's sign-up list of 586 castes): Kannada: Brahmin, Vokkaliga, Lingayat, Kuruba, Bunt, Vishwakarma, Devanga. Telugu: Brahmin, Reddy, Kamma, Kapu, Velama, Arya Vysya. Tamil: Brahmin, Iyer, Iyengar, Pillai, Gounder, Chettiar, Nadar. Hindi: Brahmin, Agarwal, Rajput, Kayastha, Yadav, Jat. Never say how many members a community has.
Never say or imply: that contact details are shared only after both families agree (paid members unlock contacts with credits); that we verify identity, age, caste, income, photos or background; guaranteed matches or marriages; "100% verified" or "safe"; any number of members, success stories or testimonials; competitor names; discounts, deadlines or "limited" offers; crossed-out or reference prices.`;

const VARIANT = {
  type: "object",
  additionalProperties: false,
  required: ["idea", "role", "angle", "kicker", "headline", "highlight", "bullets", "price", "cta", "primaryText", "title", "translation"],
  properties: {
    idea: { type: "string", enum: IDEA_KEYS, description: "The idea this variant carries" },
    role: { type: "string", enum: ["proven", "test"], description: "proven = the proven idea in new words; test = the idea being tried" },
    angle: { type: "string", description: "One line in English: the angle and why it should work for this audience" },
    kicker: { type: "string", description: "Pill at the top of the image: a short question or label, max 6 words, in the language's script" },
    headline: { type: "string", description: "Headline line 1 (dark), max 5 words" },
    highlight: { type: "string", description: "Headline line 2 (orange), max 5 words: the punchline" },
    bullets: { type: "array", items: { type: "string" }, description: "Exactly 3 ticks, max 7 words each" },
    price: { type: "string", description: "Price line, e.g. '₹351 a year', in the language" },
    cta: { type: "string", description: "Button text, max 4 words, e.g. 'Register today'" },
    primaryText: { type: "string", description: "Ad primary text above the image, max 220 characters, same language" },
    title: { type: "string", description: "Ad headline under the image, max 40 characters, same language" },
    translation: { type: "string", description: "English translation of every line above (pill, headline, ticks, price, button, primary text, title), for the owner to check" },
  },
};
const SCHEMA = { type: "object", additionalProperties: false, required: ["variants"], properties: { variants: { type: "array", items: VARIANT } } };

/** The quality check's answer: per variant, whether claims and language pass, and a fixed version if needed. */
const FIXED = { ...VARIANT, required: VARIANT.required.filter((k) => k !== "idea" && k !== "role"), properties: Object.fromEntries(Object.entries(VARIANT.properties).filter(([k]) => k !== "idea" && k !== "role")) };
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
          claimsOk: { type: "boolean", description: "Every statement is in the allowed facts; nothing on the never-say list" },
          languageOk: { type: "boolean", description: "Natural, correct and warm in the language and script; not a literal translation" },
          problems: { type: "array", items: { type: "string" }, description: "Each problem in one English line" },
          fixed: { anyOf: [FIXED, { type: "null" }], description: "A corrected version keeping the same idea, or null when it passes or can't be saved" },
        },
      },
    },
  },
};

/** Second pass: checks claims and language, fixes what it can, drops what it can't. */
export const reviewVariants = async ({ variants, language, audience, config }) => {
  if (!ideaFacts()) await loadOwnerIdeas().catch(() => {});
  const { reviews } = await ask({
    task: "ads.review",
    tier: "write",
    system: `You check Meta ads for Seetha Rama Kalyana before they go live. Be strict.
${config.brief}
${CLAIM_RULES}
${ideaFacts()}
${calendarNotes({ days: 21, language })}
For each variant: claimsOk is false if any line states or implies something outside the allowed facts or on the never-say list, or names a festival or season that isn't in the calendar above or doesn't fall in it. languageOk is false if the ${language} text is unnatural, wrong, awkward or a literal translation, or doesn't suit "${audience}".
When something is wrong and can be fixed without changing the idea, return a fixed version (all fields, same language, with an updated English translation); otherwise fixed is null.`,
    prompt: variants.map((v, i) => `Variant ${i}:\n${JSON.stringify(v)}`).join("\n\n"),
    schema: REVIEW_SCHEMA,
    maxTokens: 8000,
  });
  const out = [];
  for (const [i, v] of variants.entries()) {
    const r = reviews.find((x) => x.index === i);
    if (!r || (r.claimsOk && r.languageOk)) {
      out.push({ ...v, review: "Passed the claims and language check." });
    } else if (r.fixed) {
      out.push({ ...v, ...r.fixed, idea: v.idea, role: v.role, review: `Fixed by the check: ${r.problems.join("; ")}` });
    }
  }
  return { kept: out, dropped: variants.length - out.length, problems: reviews.flatMap((r) => r.problems) };
};

/** Ad performance over the last 14 days, keyed by ad id. */
const adStats = async () => {
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const rows = await AdSnapshot.aggregate([
    { $match: { level: "ad", date: { $gte: since } } },
    { $group: { _id: "$entityId", name: { $first: "$name" }, spend: { $sum: "$spend" }, paid: { $sum: "$paid" }, leads: { $sum: "$leads" } } },
  ]);
  return new Map(rows.map((r) => [r._id, r]));
};
const cpp = (s) => (s?.paid ? s.spend / s.paid : Infinity);
const rupees = (n) => (Number.isFinite(n) ? `₹${Math.round(n)}` : "no members yet");

/** The ad set in a campaign that most needs fresh ads (highest 7-day frequency yesterday). */
export const tiredAdset = async (campaignId) => {
  const latest = await AdSnapshot.find({ level: "adset", campaignId, frequency7: { $ne: null } }).sort({ date: -1, frequency7: -1 }).limit(1).lean();
  return latest[0] ? { adsetId: latest[0].entityId, adsetName: latest[0].name } : null;
};

/** utm_content for a new ad, e.g. "kn_ops_parents_1201a". */
const utmFor = (language, audienceKey, i) => {
  const d = new Date(Date.now() + 5.5 * 3600000);
  const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${CODES[language] ?? "xx"}_ops_${audienceKey}_${mmdd}${"abc"[i] ?? i}`;
};

/** Sets utm_content in the ad's link (when it carries one) and in its url_tags. */
export const withUtmContent = (link, urlTags, value) => {
  let nextLink = link;
  try {
    const u = new URL(link);
    if (u.searchParams.has("utm_content")) {
      u.searchParams.set("utm_content", value);
      nextLink = u.toString();
    }
  } catch {
    // Not a URL Meta would accept anyway; leave it.
  }
  const tags = new URLSearchParams(urlTags || "");
  tags.set("utm_content", value);
  return { link: nextLink, urlTags: tags.toString() };
};

/** A safe site path for an ad's link ("/pricing"), or null for "keep the copied ad's link". */
export const cleanPath = (path) => {
  const s = String(path ?? "").trim().replace(/\/+$/, "");
  if (!s || !/^\/[a-z0-9][a-z0-9\-/]{0,79}$/i.test(s) || s.includes("//")) return null;
  return s;
};

/** The copied ad's link pointed at a page in the ad's language, keeping its query (tracking). */
export const withPath = (link, language, path) => {
  const clean = cleanPath(path);
  if (!clean) return link;
  try {
    const u = new URL(link);
    u.pathname = `${langPath(language)}${clean}`;
    return u.toString();
  } catch {
    return link;
  }
};

/** "links to …/kn/pricing" or "same link as the copied ad", for a card's effect line. */
const linkNote = (creatives, language) => {
  const paths = [...new Set(creatives.map((c) => c.linkPath).filter(Boolean))];
  return paths.length ? `links to seetharamakalyana.in${paths.map((p) => `${langPath(language)}${p}`).join(" and ")}` : "same link as the copied ad";
};

/**
 * Winning ad sets, which idea plans leave alone so Meta's learning there isn't
 * reset: in each campaign with 2+ active ad sets, the one with the lowest cost
 * per member over 14 days, if it had at least RULES.minPaidToWin members.
 * (A tired winner still gets fresh ads from the regular batch.)
 * @param {Array<{ id, campaignId, name, status, spend, paid }>} rows ad sets with 14-day totals
 * @returns {Map<string, { id, campaignId, name, cpp, paid }>}
 */
export const pickWinners = (rows) => {
  const out = new Map();
  const byCampaign = new Map();
  for (const r of rows.filter((x) => x.status === "ACTIVE")) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r]);
  for (const sets of byCampaign.values()) {
    if (sets.length < 2) continue;
    const best = sets.filter((s) => s.paid >= RULES.minPaidToWin).sort((a, b) => a.spend / a.paid - b.spend / b.paid)[0];
    if (best) out.set(best.id, { id: best.id, campaignId: best.campaignId, name: best.name, cpp: best.spend / best.paid, paid: best.paid });
  }
  return out;
};

/** Every ad set's last 14 days (spend, members) with its latest name and status. */
export const adsetResults = async () => {
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const rows = await AdSnapshot.aggregate([
    { $match: { level: "adset", date: { $gte: since } } },
    { $sort: { date: 1 } },
    { $group: { _id: "$entityId", campaignId: { $last: "$campaignId" }, name: { $last: "$name" }, status: { $last: "$status" }, spend: { $sum: "$spend" }, paid: { $sum: "$paid" } } },
  ]);
  return rows.map((r) => ({ id: r._id, campaignId: r.campaignId, name: r.name, status: r.status, spend: r.spend ?? 0, paid: r.paid ?? 0 }));
};

export const winningAdsets = async () => pickWinners(await adsetResults());

/** The idea whose page an ad links to (e.g. "/pricing" → pricing), if any. */
export const ideaForPath = (path) => {
  const clean = cleanPath(path);
  return clean ? IDEA_KEYS.find((k) => cleanPath(IDEAS[k]?.path) === clean) : undefined;
};

/** Once: ads planned from an idea before they were tagged take the idea of the page they link to. */
export const tagIdeaCreatives = async () => {
  let tagged = 0;
  for (const k of IDEA_KEYS.filter((x) => cleanPath(IDEAS[x]?.path))) {
    const r = await OpsCreative.updateMany({ linkPath: cleanPath(IDEAS[k].path), idea: null }, { $set: { idea: k } });
    tagged += r.modifiedCount ?? 0;
  }
  return tagged;
};

const copyOf = async (adId) => {
  const spec = await fetchCreativeSpec(adId).catch(() => null);
  const link = spec?.object_story_spec?.link_data;
  return { text: link?.message ?? "", headline: link?.name ?? "" };
};

/**
 * Plans fresh ads for one ad set: one variant on its best PROVEN idea and one
 * TEST of the most promising untried idea. Returns the action, or why it was skipped.
 * @param {{ campaignId: string, campaignName: string, adsetId: string, adsetName?: string, notes?: string[], runAt: Date }} p
 */
export const planCreativeRefresh = async ({ campaignId, campaignName, adsetId, adsetName = "", notes = [], runAt }) => {
  const config = await getConfig();
  await loadOwnerIdeas();
  const recent = await OpsAction.findOne({
    type: "ads.creative_launch",
    "payload.adsetId": adsetId,
    status: { $in: ["scheduled", "shadow", "done", "running"] },
    createdAt: { $gte: new Date(Date.now() - 14 * 86400000) },
  });
  if (recent) return { skipped: `${adsetName || adsetId} got new ads in the last 14 days` };

  const [ads, stats, library, doubts, brides, organic, known] = await Promise.all([
    fetchAds(),
    adStats(),
    loadIdeaLibrary(60),
    familyDoubts().catch(() => []),
    bridesShare().catch(() => null),
    organicWinners().catch(() => []),
    OpsCreative.find({ adId: { $ne: null }, idea: { $ne: null } }).select("adId idea").lean(),
  ]);
  const ideaByAd = new Map(known.map((c) => [c.adId, c.idea]));
  const active = ads.filter((a) => a.campaign_id === campaignId && a.effective_status === "ACTIVE");
  if (!active.length) return { skipped: "No active ads in this campaign" };
  const ranked = [...active].filter((a) => (stats.get(a.id)?.paid ?? 0) >= 2).sort((a, b) => cpp(stats.get(a.id)) - cpp(stats.get(b.id)));
  const inSet = ranked.filter((a) => a.adset_id === adsetId);
  // Copy the ad set's own best ad (its link and button suit the audience), else the campaign's.
  const base = inSet[0] ?? ranked[0] ?? active.find((a) => a.adset_id === adsetId) ?? active[0];
  const worst = [...active]
    .filter((a) => (stats.get(a.id)?.spend ?? 0) >= 500)
    .sort((a, b) => cpp(stats.get(b.id)) - cpp(stats.get(a.id)))
    .slice(0, 2);

  const language = languageOf(campaignName);
  const audience = audienceOf(adsetName);
  const best = ranked.slice(0, 3);
  const { proven, tests } = pickIdeas({ library, language, audience: audience.key });
  const ideaLine = (k) => `${k} (${IDEAS[k].label}): ${IDEAS[k].hint}`;
  const describe = async (a) => {
    const s = stats.get(a.id);
    const c = await copyOf(a.id);
    return `- "${a.name}" [idea: ${ideaOf(a.name, ideaByAd.get(a.id))}]${a.adset_id === adsetId ? " (this ad set)" : ""}: ${rupees(s?.spend ?? 0)} spent, ${s?.paid ?? 0} members, ${rupees(cpp(s))} each. Text: ${c.text.slice(0, 300) || "(image only)"} | Headline: ${c.headline || "-"}`;
  };
  // The cards' own words matter most, so Claude sees the images: the 2 best ads, then the most expensive one.
  const shown = [...best.slice(0, 2), ...worst.filter((w) => !best.some((b) => b.id === w.id)).slice(0, 1)];
  const images = (await Promise.all(shown.map((a) => fetchAdImage(a.id)))).filter(Boolean);
  const imageNote = images.length
    ? `The ${images.length} image(s) above are, in order: ${shown.slice(0, images.length).map((a) => `"${a.name}"`).join(", ")}.`
    : "No ad images could be loaded.";
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

  const { variants } = await ask({
    task: "ads.creatives",
    tier: "ads",
    images,
    system: `You write Meta ads for Seetha Rama Kalyana, a matrimony site for families.
${config.brief}
${CLAIM_RULES}
${ideaFacts()}
Owner's standing rules:
${config.ads?.preferences ?? ""}
The ideas you may use:
${IDEA_KEYS.filter((k) => ideaTarget(k) !== "organic").map((k) => `- ${ideaLine(k)}`).join("\n")}
How to write:
- Write in ${language} in its native script (English only if the language is English). Natural and warm, the way a family in that region speaks; never a literal translation.
- The image has: a pill (short question or label), a two-line headline (line 2 is the punchline), three ticks, a price line and a button. Keep every line short; people scroll fast on phones.
- Speak to this audience only: ${audience.label}.
- Variant 1 is the PROVEN idea in fresh words: keep what makes the winning cards work (you can see them), say it differently.
- Variant 2 TESTS a new idea: pick one of the test candidates, or answer one of the families' questions below with the "answer" idea. Make it clearly different from variant 1.
- Use families' own words where they fit. Never print dates or deadlines. Today is ${today}; a festival or season may be named only from this calendar:
${calendarNotes({ days: 21, language })}`,
    prompt: `Campaign: ${campaignName} (${language}). Ad set: ${adsetName || adsetId} (${audience.key}).
Why new ads now: ${notes.join(" ") || "the same people keep seeing the same ads"}.
${imageNote}
Proven idea for this language and audience: ${proven ? `${ideaLine(proven.idea)} (₹${Math.round(proven.cpp)} per member, ${proven.where})` : "none proven yet; use the idea of the cheapest ad below"}.
Test candidates: ${tests.length ? tests.map((t) => `${t.idea} (${t.why})`).join("; ") : "none; test an 'answer' to a family's question"}.
Best ads in this campaign (last 14 days):
${(await Promise.all(best.map(describe))).join("\n") || "- none with 2+ members yet"}
Most expensive ads:
${(await Promise.all(worst.map(describe))).join("\n") || "- none"}
What families asked or doubted in the last 14 days:
${doubts.slice(0, 20).join("\n") || "- nothing recorded"}
${brides ? `Brides are ${Math.round(brides.share * 100)}% of new members (${brides.women} of ${brides.total} in 14 days); daughters' families are the gap.` : ""}
Organic posts that brought sign-ups (their message only):
${organic.join("\n") || "- none traced yet"}
Write 2 variants: 1 = proven, 2 = test.`,
    schema: SCHEMA,
    maxTokens: 12000,
  });

  const checked = await reviewVariants({ variants: variants.slice(0, 2), language, audience: audience.label, config });
  if (!checked.kept.length) {
    return { skipped: `The quality check rejected both variants: ${checked.problems.join("; ").slice(0, 300)}` };
  }

  const created = [];
  for (const [i, v] of checked.kept.entries()) {
    created.push(
      await OpsCreative.create({
        campaignId,
        campaignName,
        adsetId,
        adsetName,
        language,
        audience: audience.key,
        idea: v.idea,
        role: v.role,
        angle: v.angle,
        review: v.review,
        baseAdId: base.id,
        design: { kicker: v.kicker, headline: v.headline, highlight: v.highlight, bullets: v.bullets.slice(0, 3), price: v.price, cta: v.cta, theme: "ad" },
        primaryText: v.primaryText,
        title: v.title,
        translation: v.translation,
        utmContent: utmFor(language, audience.key, i),
        // Ideas about one page (pricing) link to it.
        linkPath: cleanPath(IDEAS[v.idea]?.path),
      })
    );
  }
  const label = (v) => `${v.role === "proven" ? "Proven idea" : "Test"}: ${IDEAS[v.idea]?.label ?? v.idea}`;
  const action = await propose(
    "ads",
    {
      type: "ads.creative_launch",
      title: `${created.length} new ads for ${campaignName} › ${adsetName || "ad set"}`,
      reason: `${notes.join(" ") || "Ad fatigue."} Built on "${base.name}" (${rupees(cpp(stats.get(base.id)))} per member).${checked.dropped ? ` The quality check dropped ${checked.dropped} variant.` : ""}\n${checked.kept
        .map((v, i) => `${i + 1}. ${label(v)}. ${v.angle}\n   ${v.review}\n   In English: ${v.translation}`)
        .join("\n")}`,
      effect: `Adds ${created.length} ads next to the current ones in ${adsetName || "the ad set"} (same button and pixel as "${base.name}", own utm_content; ${linkNote(created, language)}). Each is judged win / even / lose against the ad set after 7 days. The ad set re-learns for ~3 days.`,
      payload: { campaignId, adsetId, creativeIds: created.map((c) => String(c._id)), baseAdId: base.id, replaceAdId: null, ideas: checked.kept.map((v) => `${v.role}:${v.idea}`) },
      ref: { kind: "meta", id: `creative:${adsetId}` },
      runAt,
    },
    { dedupeKey: `ads.creative_launch:${adsetId}` }
  );
  return { action: action?._id ?? null, creatives: created.length, ideas: checked.kept.map((v) => `${v.role}:${v.idea}`) };
};

const toBase64 = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Couldn't fetch the ad image (${res.status})`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
};

/** Runs one step of a launch; a failure names the step and gives Meta's own explanation. */
const step = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Defer) throw err;
    const why = err.meta ? metaErrorText(err).replace(/^Meta said: /, "") : err.message;
    throw Object.assign(new Error(`${label}: ${why}`.slice(0, 480)), { meta: err.meta });
  }
};

/** Link-data fields Meta returns on an ad but refuses on a new creative, or that describe the old image. */
const LINK_DATA_DROP = ["picture", "child_attachments", "image_crops", "image_url", "multi_share_end_card", "multi_share_optimized"];

/**
 * The fields for a new creative: the copied ad's Page, Instagram account,
 * button and tracking, with this ad's image, text and link. Only what Meta
 * accepts on create (Graph v22): the retired standard_enhancements bundle and
 * the old Instagram field name are left out.
 */
export const creativeFieldsFor = (spec, { name, link, urlTags, hash, message, title }) => {
  const story = { ...spec.object_story_spec };
  if (story.instagram_actor_id && !story.instagram_user_id) story.instagram_user_id = story.instagram_actor_id;
  delete story.instagram_actor_id;
  const linkData = { ...story.link_data, link, image_hash: hash, message, name: title };
  for (const k of LINK_DATA_DROP) delete linkData[k];
  if (linkData.call_to_action?.value?.link) {
    linkData.call_to_action = { ...linkData.call_to_action, value: { ...linkData.call_to_action.value, link } };
  }
  story.link_data = linkData;
  const features = { ...(spec.degrees_of_freedom_spec?.creative_features_spec ?? {}) };
  delete features.standard_enhancements;
  const dof = Object.keys(features).length ? { ...spec.degrees_of_freedom_spec, creative_features_spec: features } : null;
  return { name, object_story_spec: story, ...(urlTags ? { url_tags: urlTags } : {}), ...(dof ? { degrees_of_freedom_spec: dof } : {}) };
};

/** Reads the ad a launch copies; throws when its format can't be copied. */
const launchSpec = async (baseAdId) => {
  const spec = await step("Reading the ad it copies", () => fetchCreativeSpec(baseAdId));
  if (!spec?.object_story_spec?.link_data) {
    throw new Error("The best ad uses a format the agent can't copy (e.g. flexible or catalogue). The new images are in Ops → Ads; add them by hand.");
  }
  return spec;
};

/** Uploads the image and makes the Meta creative once (no ad is touched); a retry reuses it. */
const prepareCreative = async (c, spec) => {
  if (c.metaCreativeId) return c.metaCreativeId;
  const label = `${c.language} ad "${c.design?.headline ?? c.title ?? ""}"`.slice(0, 80);
  const hash = await step(`${label}: uploading the image`, async () => uploadAdImage(await toBase64(c.imageUrl), `ops-${c._id}.jpg`));
  const baseLink = withPath(spec.object_story_spec.link_data.link, c.language, c.linkPath);
  const utm = c.utmContent ? withUtmContent(baseLink, spec.url_tags, c.utmContent) : { link: baseLink, urlTags: spec.url_tags };
  const fields = creativeFieldsFor(spec, {
    name: `Ops | ${c.language} | ${c.design?.headline ?? ""}`.slice(0, 100),
    link: utm.link,
    urlTags: utm.urlTags,
    hash,
    message: c.primaryText,
    title: c.title,
  });
  const creative = await step(`${label}: creating the creative`, () => createCreative(fields));
  if (!creative?.id) throw new Error(`${label}: Meta didn't return the creative`);
  c.metaCreativeId = creative.id;
  await c.save();
  return creative.id;
};

/**
 * Makes the Meta creatives of a launch card now, without touching any ad, so
 * a problem shows (with Meta's reason) hours before the launch instead of at
 * it. The launch then reuses them. Returns { ok, error? }.
 */
export const checkLaunch = async (action) => {
  const all = await OpsCreative.find({ _id: { $in: action.payload?.creativeIds ?? [] } });
  // Images still being designed: check once they're ready.
  if (all.some((c) => c.status === "design")) return { ok: true, checked: 0, pending: true };
  const creatives = all.filter((c) => c.status === "ready");
  if (!creatives.length) return { ok: true, checked: 0 };
  try {
    const spec = await launchSpec(action.payload.baseAdId);
    for (const c of creatives) await prepareCreative(c, spec);
    return { ok: true, checked: creatives.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

/**
 * A full rehearsal of a launch card's Meta steps with nothing going live: the
 * creatives are made, the ad is copied into its ad set (paused, as a launch
 * does), the new creative is put on the copy and read back, and the copy is
 * deleted. Returns { ok, steps, error? }.
 */
export const rehearseLaunch = async (action) => {
  const p = action.payload ?? {};
  const steps = [];
  const creatives = await OpsCreative.find({ _id: { $in: p.creativeIds ?? [] }, status: "ready" });
  if (!creatives.length) return { ok: false, steps, error: "No ready ad on this card to test" };
  let adId = null;
  try {
    const spec = await launchSpec(p.baseAdId);
    steps.push("Read the ad it copies");
    for (const c of creatives) await prepareCreative(c, spec);
    steps.push(`Made ${creatives.length} creative(s) in Meta`);
    const c = creatives[0];
    adId = await step("Copying the ad", () => copyAd(p.baseAdId, p.adsetId));
    if (!adId) throw new Error("Copying the ad: Meta didn't return the copied ad");
    steps.push("Copied the ad into its ad set (paused)");
    await step("Putting the new creative on the copy", () => graphPost(adId, { creative: { creative_id: c.metaCreativeId }, name: "OPS TEST (deleted after the test)" }));
    const back = await step("Reading the copy back", () => graphGet(adId, { fields: "creative{id},adset_id,effective_status" }));
    if (String(back.creative?.id) !== String(c.metaCreativeId)) throw new Error("Reading the copy back: the new creative isn't on it");
    if (String(back.adset_id) !== String(p.adsetId)) throw new Error("Reading the copy back: it landed in another ad set");
    if (back.effective_status === "ACTIVE") throw new Error("Reading the copy back: it's live, but a test copy must stay paused");
    steps.push(`Put the new creative on the copy (status ${back.effective_status})`);
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, steps, error: err.message };
  } finally {
    if (adId) {
      const removed = await graphDelete(adId).then(() => true, () => setStatus(adId, "DELETED").then(() => true, () => false));
      steps.push(removed ? "Deleted the test copy" : `Couldn't delete the test copy ${adId}: delete it in Ads Manager`);
    }
  }
};

/**
 * Checks a launch card and records the result on it. A pass marks any
 * earlier "would fail" alert for the card resolved (whoever ran the check).
 */
export const checkAndRecord = async (card) => {
  const r = await checkLaunch(card);
  if (r.pending) return r;
  await OpsAction.updateOne({ _id: card._id }, { $set: { "payload.checkedAt": new Date(), "payload.checkError": r.ok ? null : r.error } });
  if (r.ok) {
    await OpsAction.updateMany(
      { type: "ads.launch_check_failed", "payload.dedupeKey": `launch_check:${card._id}`, status: "info", "payload.resolvedAt": null },
      { $set: { "payload.resolvedAt": new Date() } }
    );
  }
  return r;
};

/**
 * New-ad launches due within a day are checked ahead (their creatives made in
 * Meta, no ad touched). If Meta refuses, the owner hears at once (urgent:
 * WhatsApp) while there's time; the check repeats every 3 hours and the alert
 * is marked resolved once it passes. One card per call, soonest first.
 */
export const preflightLaunches = async ({ now = Date.now() } = {}) => {
  const card = await OpsAction.findOne({
    type: "ads.creative_launch",
    status: "scheduled",
    runAt: { $lte: new Date(now + 24 * 3600000) },
    $or: [{ "payload.checkedAt": null }, { "payload.checkError": { $ne: null }, "payload.checkedAt": { $lte: new Date(now - 3 * 3600000) } }],
  }).sort({ runAt: 1 });
  if (!card) return null;
  const r = await checkAndRecord(card);
  if (!r.ok && !r.pending) {
    const due = new Date(card.runAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    await notice("ads", {
      type: "ads.launch_check_failed",
      priority: "urgent",
      title: `New ads due ${due} would fail: ${card.title}`.slice(0, 160),
      reason: `Meta refused the new ad while it was checked ahead: ${r.error}`,
      effect: "Nothing in Meta was changed. The agent checks again every 3 hours; if it still fails at launch time, the card fails and can be retried after a fix.",
      payload: { dedupeKey: `launch_check:${card._id}`, whatsappKey: "launch_check" },
    });
  }
  return r;
};

handle("ads.creative_launch", async (action) => {
  const p = action.payload;
  const creatives = await OpsCreative.find({ _id: { $in: p.creativeIds } });
  if (creatives.some((c) => c.status === "design")) {
    if ((p.deferrals ?? 0) >= 6) throw new Error("The ad images were never designed. Check the Ops render GitHub Action.");
    throw new Defer("Waiting for the ad images to be designed; trying again in 2 hours.");
  }
  const spec = await launchSpec(p.baseAdId);
  const ready = creatives.filter((x) => x.status === "ready");
  // Every creative first: a problem shows before any ad set is touched.
  for (const c of ready) await prepareCreative(c, spec);
  // Ads that went live on an earlier try of this card stay as they are.
  const adIds = creatives.filter((c) => c.status === "live" && c.adId).map((c) => c.adId);
  for (const c of ready) {
    const code = CODES[c.language] ?? "XX";
    const adId = await step("Copying the ad", () => copyAd(p.baseAdId, p.adsetId));
    if (!adId) throw new Error("Copying the ad: Meta didn't return the copied ad");
    try {
      await step("Putting the new creative on the copy", () =>
        graphPost(adId, { creative: { creative_id: c.metaCreativeId }, name: `${code.toUpperCase()}-OPS ${c.utmContent ?? ""} ${c.design?.headline ?? ""}`.trim().slice(0, 100) })
      );
      await step("Turning the new ad on", () => setStatus(adId, "ACTIVE"));
    } catch (err) {
      // The copy is still the old ad's paused twin: remove it, so a retry starts clean.
      await graphDelete(adId).catch(() => setStatus(adId, "DELETED").catch(() => {}));
      throw err;
    }
    c.adId = adId;
    c.status = "live";
    c.liveAt = new Date();
    await c.save();
    adIds.push(adId);
    if (c.imageFileId) await imagekit.deleteFile(c.imageFileId).catch(() => {});
  }
  // Older cards also paused the weakest ad here; new batches pause through ads.pause_ad.
  if (p.replaceAdId) await setStatus(p.replaceAdId, "PAUSED");
  return { adIds, paused: p.replaceAdId ?? null };
});

handleUndo("ads.creative_launch", async (action) => {
  for (const id of action.result?.adIds ?? []) await setStatus(id, "PAUSED");
  if (action.result?.paused) await setStatus(action.result.paused, "ACTIVE");
});

/**
 * New ads from given copy (an owner's idea): adds them next to the existing
 * ads, copying the ad set's best ad for link, button and tracking. Nothing is
 * paused. Returns the proposed action.
 */
export const proposeIdeaCreatives = async ({ campaignId, campaignName, adsetId, language, variants, runAt, reason, ideaId, path = "", useWinner = false }) => {
  const [ads, stats, winners] = await Promise.all([fetchAds(), adStats(), winningAdsets()]);
  const active = ads.filter((a) => a.campaign_id === campaignId && a.effective_status === "ACTIVE");
  if (!active.length) throw new Error(`No active ads in ${campaignName} to copy the setup from`);
  const ranked = [...active].filter((a) => (stats.get(a.id)?.paid ?? 0) >= 2).sort((a, b) => cpp(stats.get(a.id)) - cpp(stats.get(b.id)));
  let target = adsetId && active.some((a) => a.adset_id === adsetId) ? adsetId : (ranked[0] ?? active[0]).adset_id;
  // The winning ad set is left alone (its learning isn't reset) unless the owner asked for it.
  let protectNote = "";
  const winner = winners.get(target);
  if (winner && !useWinner) {
    const others = [...new Set(active.map((a) => a.adset_id))].filter((id) => !winners.has(id));
    const alt = ranked.find((a) => others.includes(a.adset_id))?.adset_id ?? others[0];
    if (alt) {
      target = alt;
      protectNote = ` Kept out of "${winner.name}", this campaign's winning ad set (₹${Math.round(winner.cpp)} per member), so its learning isn't reset.`;
    }
  } else if (winner) {
    protectNote = ` Goes into "${winner.name}", the winning ad set, as you asked; it re-learns for ~3 days.`;
  }
  const linkPath = cleanPath(path);
  const base = ranked.find((a) => a.adset_id === target) ?? ranked[0] ?? active.find((a) => a.adset_id === target) ?? active[0];
  const adsetName = (await AdSnapshot.findOne({ level: "adset", entityId: target }).sort({ date: -1 }).lean())?.name ?? "";
  const audience = audienceOf(adsetName);
  const created = [];
  for (const [i, v] of variants.slice(0, 3).entries()) {
    created.push(
      await OpsCreative.create({
        campaignId,
        campaignName,
        adsetId: target,
        adsetName,
        language,
        audience: audience.key,
        baseAdId: base.id,
        design: {
          kicker: v.kicker,
          headline: v.headline,
          // Older idea plans had a single subline; it becomes the orange line.
          highlight: v.highlight ?? v.subline,
          bullets: v.bullets?.slice(0, 3),
          price: v.price,
          cta: v.cta,
          theme: "ad",
        },
        primaryText: v.primaryText,
        title: v.title,
        translation: v.translation,
        utmContent: utmFor(language, audience.key, i),
        // An owner's idea is always a test; untagged ads that link to an idea's page take that idea.
        idea: IDEA_KEYS.includes(v.idea) ? v.idea : ideaForPath(linkPath),
        role: "test",
        linkPath: linkPath ?? cleanPath(IDEAS[v.idea]?.path),
      })
    );
  }
  return propose("ads", {
    type: "ads.creative_launch",
    title: `${created.length} new ad${created.length > 1 ? "s" : ""} for ${campaignName}`,
    reason: `${reason}${protectNote} Headlines: “${variants.map((v) => [v.headline, v.highlight ?? v.subline].filter(Boolean).join(" ")).join("”, “")}”.${variants
      .filter((v) => v.translation)
      .map((v, i) => `\n${i + 1}. In English: ${v.translation}`)
      .join("")}`,
    effect: `Copies "${base.name}" (button, tracking) with the new images and text and starts ${created.length > 1 ? "them" : "it"} next to the current ads in ${adsetName || "the ad set"}, each with its own utm_content; ${linkNote(created, language)}. Nothing is paused.`,
    payload: { campaignId, adsetId: target, creativeIds: created.map((c) => String(c._id)), baseAdId: base.id, replaceAdId: null, ideaId },
    ref: { kind: "meta", id: `idea-creative:${ideaId}:${campaignId}` },
    runAt,
  });
};
