export const expiresIn = "6h";

export const SUPPORT_EMAIL = "contactus@seetharamakalyana.in";

// Prices are decided here, never by the browser. Keep the frontend's display
// constants (kalyanam_FE/src/utils/constants.ts) in sync with these.
export const REGISTRATION_FEE = 351;
// Members who register with a broker's referral code pay less; the broker is
// paid BROKER_COMMISSION per such registration (outside the site).
export const REFERRAL_REGISTRATION_FEE = 301;
export const BROKER_COMMISSION = 101;
export const BROKER_REGISTRATION_FEE = 501;
export const REGISTRATION_INTERESTS = 36;
// Promo codes: accepted, but charged the normal fee and nobody earns a commission.
export const DISCOUNT_CODES = ["BRAHMIN", "SITARAM"];

export const INTEREST_PACKS = {
  basic: { amount: 101, interests: 21 },
  premium: { amount: 251, interests: 56 },
};

export const ASTRO_FEES = {
  Overview: 51,
  Personalized: 251,
  "Kundli Matching": 201,
};

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
