// Loads .env and checks configuration before anything else reads process.env.
// Import this first in src/index.js: ES module imports run in order, so any
// module imported earlier would see an empty environment. See .env.example.
import "dotenv/config";

const REQUIRED = [
  "MONGO_URI",
  "JWT_SECRET",
  "FRONTEND_URL",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "IMAGEKIT_PUBLIC_KEY",
  "IMAGEKIT_PRIVATE_KEY",
  "IMAGEKIT_URL_ENDPOINT",
  "MSG91_AUTHKEY",
  "MSG91_EMAIL_API",
  "MSG91_EMAIL_FROM",
  "MSG91_DOMAIN",
];

// Features that quietly stop working without these.
const RECOMMENDED = {
  RAZORPAY_WEBHOOK_SECRET: "the Razorpay webhook rejects every call, so payments whose tab closed are never fulfilled",
  QSTASH_TOKEN: "the webhook can't queue fulfilment",
  INTERNAL_ROUTE_SECRET: "queued fulfilment calls are rejected",
  BASE_URL: "queued fulfilment has nowhere to go",
  MSG91_WHATSAPP_API: "WhatsApp OTPs can't be sent",
  OPENAI_API_KEY: "astrology insights fail",
  FREE_ASTRO_API_KEY: "astrology charts fail",
  TIMEZONEDB_KEY: "astrology time zones fail",
};

export const isProduction =
  process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}. See .env.example.`
  );
}

for (const [key, effect] of Object.entries(RECOMMENDED)) {
  if (!process.env[key]) console.warn(`[env] ${key} is not set: ${effect}.`);
}

if (isProduction) {
  if (String(process.env.JWT_SECRET).length < 32) {
    console.warn("[env] JWT_SECRET is shorter than 32 characters; use a long random value.");
  }
  if (String(process.env.RAZORPAY_KEY_ID).startsWith("rzp_test_")) {
    console.warn("[env] RAZORPAY_KEY_ID is a test key in production: no real payments will be taken.");
  }
  if (process.env.TEST_PAYMENT_EMAILS) {
    console.warn("[env] TEST_PAYMENT_EMAILS is set: those accounts are charged ₹1.");
  }
}

/** Browser origins allowed by CORS: FRONTEND_URL (+ its www/apex twin) and CORS_ORIGINS. */
export const allowedOrigins = (() => {
  const origins = new Set();
  for (const raw of [process.env.FRONTEND_URL, ...String(process.env.CORS_ORIGINS || "").split(",")]) {
    let value = String(raw || "").trim().replace(/\/+$/, "");
    if (!value) continue;
    // Accept a bare domain ("example.com") as its https origin.
    if (!/^https?:\/\//.test(value)) value = `https://${value}`;
    try {
      const url = new URL(value);
      origins.add(url.origin);
      const twin = url.hostname.startsWith("www.")
        ? url.hostname.slice(4)
        : url.hostname.split(".").length === 2
        ? `www.${url.hostname}`
        : null;
      if (twin) origins.add(`${url.protocol}//${twin}${url.port ? `:${url.port}` : ""}`);
    } catch {
      console.warn(`[env] Ignoring invalid CORS origin: ${value}`);
    }
  }
  return [...origins];
})();
