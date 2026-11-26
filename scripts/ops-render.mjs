/*
 * Renders organic post images in Chromium (run by .github/workflows/ops-render.yml).
 *
 *   node scripts/ops-render.mjs             → renders the backend's queue and sends the PNGs back
 *   node scripts/ops-render.mjs --sample DIR → renders sample cards in every language to DIR
 *
 * Queue mode needs BASE_URL (public API base with trailing slash) and either
 * RENDER_TOKEN (a 3-hour pass the backend sends with each render request) or
 * INTERNAL_ROUTE_SECRET.
 */
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { SIZE, postHtml } from "../src/ops/postDesign.js";

export const renderCards = async (posts) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    const out = [];
    for (const post of posts) {
      await page.setContent(postHtml(post), { waitUntil: "load" });
      await page.waitForSelector("body[data-ready='1']", { timeout: 15000 });
      out.push({ post, image: await page.screenshot({ type: "jpeg", quality: 92 }) });
    }
    return out;
  } finally {
    await browser.close();
  }
};

const SAMPLES = [
  { id: "kannada", language: "Kannada", theme: "saffron", kicker: "ಕುಟುಂಬದ ಮೌಲ್ಯಗಳು", headline: "ಎರಡು ಕುಟುಂಬಗಳು, ಒಂದು ಹೊಸ ಆರಂಭ", subline: "ಹಿರಿಯರ ಆಶೀರ್ವಾದದೊಂದಿಗೆ ಸರಿಯಾದ ಸಂಗಾತಿಯನ್ನು ಹುಡುಕಿ" },
  { id: "telugu", language: "Telugu", theme: "cream", kicker: "భద్రతా సూచన", headline: "మొదటి సారి కలిసేటప్పుడు బహిరంగ ప్రదేశాన్ని ఎంచుకోండి", subline: "మీ కుటుంబానికి ముందుగా తెలియజేయండి" },
  { id: "tamil", language: "Tamil", theme: "maroon", kicker: "திருமண வாழ்த்துக்கள்", headline: "உங்கள் வாழ்க்கைத் துணையை இங்கே கண்டறியுங்கள்", subline: "குடும்பத்தின் ஆசியுடன் ஒரு புதிய பயணம்" },
  { id: "hindi", language: "Hindi", theme: "green", kicker: "क्यों जुड़ें", headline: "सही रिश्ता, परिवार की सहमति से", subline: "सत्यापित प्रोफ़ाइल, सरल प्रक्रिया" },
  { id: "english", language: "English", theme: "saffron", kicker: "How matching works", headline: "Matches that respect your family's values", subline: "Language, community and horoscope, all in one place" },
];

const api = async (route, body) => {
  const res = await fetch(`${process.env.BASE_URL}${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(process.env.RENDER_TOKEN ? { "x-render-token": process.env.RENDER_TOKEN } : { "x-internal-secret": process.env.INTERNAL_ROUTE_SECRET }),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route}: ${res.status} ${data.msg || ""}`);
  return data;
};

const main = async () => {
  const sampleAt = process.argv.indexOf("--sample");
  if (sampleAt > -1) {
    const dir = process.argv[sampleAt + 1] || "render-samples";
    fs.mkdirSync(dir, { recursive: true });
    for (const { post, image } of await renderCards(SAMPLES)) fs.writeFileSync(path.join(dir, `${post.id}.jpg`), image);
    console.log(`Wrote ${SAMPLES.length} samples to ${dir}`);
    return;
  }
  if (!process.env.BASE_URL || !(process.env.RENDER_TOKEN || process.env.INTERNAL_ROUTE_SECRET)) {
    throw new Error("BASE_URL and a RENDER_TOKEN (sent by the backend) or INTERNAL_ROUTE_SECRET are required");
  }
  const { posts } = await api("ops/render-queue");
  console.log(`${posts.length} post(s) to render`);
  for (const { post, image } of await renderCards(posts)) {
    await api("ops/render-done", { postId: post._id, jpeg: image.toString("base64") });
    console.log("rendered", post._id, post.language, post.headline);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
