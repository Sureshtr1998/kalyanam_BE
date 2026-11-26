import fs from "fs";

/*
 * The organic post card, as one self-contained HTML page (fonts and logo
 * inlined). It is rendered by Chromium in the "Ops render" GitHub Action
 * (scripts/ops-render.mjs), because only a real browser engine shapes
 * Kannada, Telugu, Tamil and Devanagari text correctly. The page fits its
 * own headline: it shrinks the font until every line fits the card.
 *
 * Fonts: Noto Sans (Kannada/Telugu/Tamil/Devanagari/Latin) and Fraunces,
 * SIL Open Font License, bundled in assets/fonts.
 */

export const SIZE = { width: 1080, height: 1350 };

const FONTS = [
  ["Fraunces", 700, "normal", "Fraunces_700Bold.ttf"],
  ["Fraunces", 600, "italic", "Fraunces_600SemiBold_Italic.ttf"],
  ["Noto Sans", 400, "normal", "NotoSans_400Regular.ttf"],
  ["Noto Sans", 600, "normal", "NotoSans_600SemiBold.ttf"],
  ["Noto Sans Kannada", 400, "normal", "NotoSansKannada_400Regular.ttf"],
  ["Noto Sans Kannada", 700, "normal", "NotoSansKannada_700Bold.ttf"],
  ["Noto Sans Telugu", 400, "normal", "NotoSansTelugu_400Regular.ttf"],
  ["Noto Sans Telugu", 700, "normal", "NotoSansTelugu_700Bold.ttf"],
  ["Noto Sans Tamil", 400, "normal", "NotoSansTamil_400Regular.ttf"],
  ["Noto Sans Tamil", 700, "normal", "NotoSansTamil_700Bold.ttf"],
  ["Noto Sans Devanagari", 400, "normal", "NotoSansDevanagari_400Regular.ttf"],
  ["Noto Sans Devanagari", 700, "normal", "NotoSansDevanagari_700Bold.ttf"],
];

const asset = (p) => new URL(`../../assets/${p}`, import.meta.url);

let cached;
/** Fonts as @font-face rules and the logo as a data URL (read once). */
export const designAssets = () => {
  cached ??= {
    fontCss: FONTS.map(
      ([family, weight, style, file]) =>
        `@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};src:url(data:font/ttf;base64,${fs
          .readFileSync(asset(`fonts/${file}`))
          .toString("base64")}) format("truetype");}`
    ).join("\n"),
    logo: `data:image/png;base64,${fs.readFileSync(asset("brand/logo.png")).toString("base64")}`,
  };
  return cached;
};

const SCRIPT_FONT = {
  kannada: "Noto Sans Kannada",
  telugu: "Noto Sans Telugu",
  tamil: "Noto Sans Tamil",
  hindi: "Noto Sans Devanagari",
  marathi: "Noto Sans Devanagari",
  sanskrit: "Noto Sans Devanagari",
};
/** The font for a language name like "Kannada" or "Telugu (Telugu script)". English uses Fraunces. */
export const fontFor = (language = "") => SCRIPT_FONT[String(language).toLowerCase().split(/[\s(]/)[0]] ?? null;

export const THEMES = {
  saffron: { bg1: "#c2410c", bg2: "#7c2d12", ink: "#fff8f1", soft: "#fed7aa", accent: "#f59e0b", motif: "#fde68a", pill: "#fff8f1", pillInk: "#9a3412", motifOpacity: 0.13 },
  cream: { bg1: "#fffaf3", bg2: "#fde9d2", ink: "#431407", soft: "#9a3412", accent: "#c2410c", motif: "#f59e0b", pill: "#c2410c", pillInk: "#fff8f1", motifOpacity: 0.18 },
  maroon: { bg1: "#5b0f14", bg2: "#2b0a0c", ink: "#fde9d2", soft: "#f5c99b", accent: "#f59e0b", motif: "#f59e0b", pill: "#f59e0b", pillInk: "#2b0a0c", motifOpacity: 0.13 },
  green: { bg1: "#14532d", bg2: "#052e16", ink: "#f0fdf4", soft: "#bbf7d0", accent: "#f59e0b", motif: "#fde68a", pill: "#fde68a", pillInk: "#14532d", motifOpacity: 0.12 },
};
export const THEME_NAMES = Object.keys(THEMES);

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Mandala of petal rings and dots (SVG), drawn behind the headline. */
const mandala = (color) => {
  const c = 500;
  const parts = [];
  for (const [radius, petals, len, w] of [[330, 24, 60, 16], [238, 16, 52, 19], [152, 12, 46, 22]]) {
    parts.push(`<circle cx="${c}" cy="${c}" r="${radius}" fill="none" stroke="${color}" stroke-width="2"/>`);
    for (let i = 0; i < petals; i++) {
      parts.push(`<ellipse cx="${c}" cy="${c - radius - len / 2}" rx="${w}" ry="${len / 2}" fill="${color}" transform="rotate(${(i / petals) * 360} ${c} ${c})"/>`);
    }
  }
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    parts.push(`<circle cx="${c + Math.cos(a) * 420}" cy="${c + Math.sin(a) * 420}" r="7" fill="${color}"/>`);
  }
  return `<svg viewBox="0 0 1000 1000" width="1000" height="1000">${parts.join("")}</svg>`;
};

const corner = (color, cls) =>
  `<svg class="corner ${cls}" viewBox="0 0 90 90" width="90" height="90"><g fill="none" stroke="${color}" stroke-width="3"><path d="M4 74 Q4 4 74 4"/><path d="M4 50 Q4 4 50 4"/></g><circle cx="26" cy="26" r="8" fill="${color}"/><circle cx="74" cy="4" r="5" fill="${color}"/><circle cx="4" cy="74" r="5" fill="${color}"/></svg>`;

/**
 * One post card.
 * @param {{ language: string, kicker?: string, headline: string, subline?: string, theme?: string }} post
 */
export const postHtml = (post, assets = designAssets()) => {
  const t = THEMES[post.theme] ?? THEMES.saffron;
  const script = fontFor(post.language);
  const head = script ? `"${script}", "Noto Sans"` : `"Fraunces", "Noto Sans"`;
  const body = script ? `"${script}", "Noto Sans"` : `"Noto Sans"`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${assets.fontCss}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${SIZE.width}px;height:${SIZE.height}px;overflow:hidden}
body{background:linear-gradient(160deg,${t.bg1},${t.bg2});color:${t.ink};position:relative;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;background:radial-gradient(circle at 50% 44%,${t.accent}38,transparent 60%)}
.mandala{position:absolute;left:40px;top:110px;opacity:${t.motifOpacity}}
.frame{position:absolute;inset:40px;border:4px solid ${t.accent};border-radius:28px}
.frame2{position:absolute;inset:58px;border:2px solid ${t.accent}80;border-radius:20px}
.corner{position:absolute}.tl{left:72px;top:72px}.tr{right:72px;top:72px;transform:rotate(90deg)}.br{right:72px;bottom:72px;transform:rotate(180deg)}.bl{left:72px;bottom:72px;transform:rotate(270deg)}
.content{position:absolute;left:110px;right:110px;top:140px;height:860px;display:flex;flex-direction:column;align-items:center;text-align:center}
.kicker{background:${t.pill};color:${t.pillInk};font-family:${body};font-weight:700;font-size:30px;padding:12px 34px;border-radius:999px;${script ? "" : "letter-spacing:3px;text-transform:uppercase;font-weight:600;"}}
.middle{flex:1;display:flex;flex-direction:column;justify-content:center;gap:34px;width:100%}
h1{font-family:${head};font-weight:700;line-height:${script ? 1.4 : 1.1};text-wrap:balance;overflow-wrap:break-word}
p.sub{font-family:${body};font-weight:400;color:${t.soft};font-size:38px;line-height:1.5;text-wrap:balance}
.rule{position:absolute;left:50%;top:1068px;width:320px;height:2px;margin-left:-160px;background:${t.accent}}
.rule::after{content:"";position:absolute;left:50%;top:-6px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:${t.accent}}
.brand{position:absolute;left:0;right:0;top:1110px;display:flex;align-items:center;justify-content:center;gap:26px}
.brand img{width:124px;height:124px;border-radius:50%;background:#fff8f1;padding:4px}
.brand b{display:block;font-family:"Fraunces";font-weight:700;font-size:46px;line-height:1.1}
.brand span{display:block;font-family:"Noto Sans";font-weight:600;font-size:30px;color:${t.soft};letter-spacing:1px}
</style></head><body>
<div class="glow"></div>
<div class="mandala">${mandala(t.motif)}</div>
<div class="frame"></div><div class="frame2"></div>
${corner(t.accent, "tl")}${corner(t.accent, "tr")}${corner(t.accent, "br")}${corner(t.accent, "bl")}
<div class="content">
  ${post.kicker ? `<div class="kicker">${esc(post.kicker)}</div>` : ""}
  <div class="middle"><h1 id="h">${esc(post.headline)}</h1>${post.subline ? `<p class="sub" id="s">${esc(post.subline)}</p>` : ""}</div>
</div>
<div class="rule"></div>
<div class="brand"><img src="${assets.logo}" alt=""><div><b>Seetha Rama Kalyana</b><span>seetharamakalyana.in</span></div></div>
<script>
// Fit: largest headline size (≤ ${script ? 92 : 104}px) whose lines all fit, at most 4 lines, block within the middle area.
document.fonts.ready.then(() => {
  const h = document.getElementById("h"), s = document.getElementById("s"), box = document.querySelector(".middle");
  let size = ${script ? 92 : 104};
  const lines = () => Math.round(h.getBoundingClientRect().height / (parseFloat(getComputedStyle(h).lineHeight)));
  for (;;) {
    h.style.fontSize = size + "px";
    const fits = h.scrollWidth <= h.clientWidth + 1 && lines() <= 4 && box.scrollHeight <= box.clientHeight + 1;
    if (fits || size <= 44) break;
    size -= 4;
  }
  if (s) { let ss = 38; while (box.scrollHeight > box.clientHeight + 1 && ss > 26) { ss -= 2; s.style.fontSize = ss + "px"; } }
  document.body.dataset.ready = "1";
});
</script>
</body></html>`;
};
