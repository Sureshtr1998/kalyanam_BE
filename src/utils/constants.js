export const expiresIn = "6h";

export const SUPPORT_EMAIL = "contactus@seetharamakalyana.in";

// Prices live in utils/pricing.js (one table per pricing level), never in the browser.
// Promo codes: accepted, but charged the normal fee and nobody earns a commission.
export const DISCOUNT_CODES = ["BRAHMIN", "SITARAM"];

/** Accounts listed in TEST_PAYMENT_EMAILS are charged ₹1 (for live testing). */
export const isTestPayer = (email) =>
  String(process.env.TEST_PAYMENT_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(String(email || "").toLowerCase());

export const normalizeEmail = (email) =>
  typeof email === "string" ? email.trim().toLowerCase() : "";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MOBILE_RE = /^\d{10}$/;

// For new passwords only; existing shorter ones still log in.
export const MIN_PASSWORD_LENGTH = 8;
export const isValidPassword = (p) =>
  typeof p === "string" && p.length >= MIN_PASSWORD_LENGTH && p.length <= 128;
export const PASSWORD_RULE_MSG = `Password should be at least ${MIN_PASSWORD_LENGTH} characters.`;
