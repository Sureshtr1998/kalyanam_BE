/*
 * Site links for posts, comment replies and ads. Every link opens the page in
 * the post's language, and organic links carry a short tracking code
 * (?p=fkn1127): the site remembers it (FE lib/attribution.ts) and the
 * member's sign-up stores it (User.acquisition.utmContent), so sign-ups can
 * be counted per post.
 *
 * Codes: "f" (Facebook) or "i" (Instagram) + language code + MMDD of the
 * post, e.g. fkn1127. Fixed codes: "bio" (Instagram bio link), "fbpage"
 * (the Facebook Page's Sign up button), "fc" / "ic" (comment replies).
 */

export const SITE = () => (process.env.SITE_URL || "https://www.seetharamakalyana.in").replace(/\/+$/, "");
const DOMAIN = "seetharamakalyana.in";

export const LANG_CODE = { Kannada: "kn", Telugu: "te", Tamil: "ta", Hindi: "hi", English: "en" };

/** "Kannada" → "kn" (English and anything unknown → "en"). */
export const langCode = (language = "") => LANG_CODE[String(language).split(/[\s(]/)[0]] ?? "en";

/** "/kn" for regional languages, "" for English. */
export const langPath = (language) => (langCode(language) === "en" ? "" : `/${langCode(language)}`);

/** The short address people can type, e.g. "seetharamakalyana.in/kn". */
export const shortUrl = (language) => `${DOMAIN}${langPath(language)}`;

/** A post's tracking code without the platform letter, e.g. "kn1127" (IST date). */
export const postCode = (language, publishAt) => {
  const d = new Date(new Date(publishAt).getTime() + 5.5 * 3600000);
  return `${langCode(language)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

/** The clickable tracked link, e.g. https://www.seetharamakalyana.in/kn?p=fkn1127 */
export const trackedLink = (language, p) => `${SITE()}${langPath(language)}${p ? `?p=${encodeURIComponent(p)}` : ""}`;

/** Which platform an organic code came from. */
export const codeSource = (p = "") => (p === "bio" || p.startsWith("i") ? "instagram" : "facebook");
