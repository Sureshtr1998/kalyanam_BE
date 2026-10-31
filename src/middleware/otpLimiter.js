import rateLimit from "express-rate-limit";
import upStash from "../config/upStash.js";

// Counts one hit and returns [hits, ms until the window resets]. The window
// starts on the first hit, so it's a fixed window per client. Runs as one
// script so concurrent requests can't both see a fresh key.
const INCREMENT_SCRIPT = `
local hits = redis.call("INCR", KEYS[1])
if hits == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * Counts one hit on `key` in a fixed window and returns the running total,
 * for limits keyed by something other than the client IP (an email address).
 * @param {string} key
 * @param {number} windowMs
 * @returns {Promise<number>}
 */
export const countHit = async (key, windowMs) => {
  const [hits] = /** @type {[number, number]} */ (
    await upStash.eval(INCREMENT_SCRIPT, [`rl:${key}`], [String(windowMs)])
  );
  return hits;
};

/**
 * Keeps rate-limit counters in Upstash Redis. The default in-memory store is
 * per process, and on Vercel every serverless instance (and every cold start)
 * would get its own fresh counters.
 * @typedef {import("express-rate-limit").Store} Store
 * @implements {Store}
 */
class UpstashStore {
  /** @param {string} name Unique per limiter, so their counters don't mix. */
  constructor(name) {
    this.prefix = `rl:${name}:`;
    this.windowMs = 60 * 1000;
  }

  /** @param {import("express-rate-limit").Options} options */
  init(options) {
    this.windowMs = options.windowMs;
  }

  /** @param {string} key */
  async increment(key) {
    const [totalHits, ttl] = /** @type {[number, number]} */ (
      await upStash.eval(INCREMENT_SCRIPT, [this.prefix + key], [String(this.windowMs)])
    );
    return { totalHits, resetTime: new Date(Date.now() + ttl) };
  }

  /** @param {string} key */
  async decrement(key) {
    await upStash.decr(this.prefix + key);
  }

  /** @param {string} key */
  async resetKey(key) {
    await upStash.del(this.prefix + key);
  }
}

/**
 * @param {string} name
 * @param {number} windowMs
 * @param {number} limit
 * @param {string} msg
 * @param {Partial<import("express-rate-limit").Options>} [extra]
 */
const limiter = (name, windowMs, limit, msg, extra = {}) =>
  rateLimit({
    windowMs,
    limit,
    store: new UpstashStore(name),
    // If Redis is down, let requests through rather than locking everyone out.
    passOnStoreError: true,
    message: { success: false, msg },
    ...extra,
  });

const otpLimiter = limiter("otp", 10 * 60 * 1000, 13, "Too many OTP requests. Try again later.");

export const loginLimiter = limiter(
  "login",
  15 * 60 * 1000,
  20,
  "Too many login attempts. Please try again in a few minutes."
);

export const uploadLimiter = limiter("upload", 10 * 60 * 1000, 20, "Too many uploads. Try again later.");

// Site-wide ceiling on uploads from people who haven't registered yet, so a
// botnet spread over many IPs still can't fill ImageKit. Each call is up to 3 photos.
export const anonymousUploadLimiter = limiter(
  "upload-anon-daily",
  24 * 60 * 60 * 1000,
  Number(process.env.ANON_UPLOAD_DAILY_LIMIT) || 300,
  "Photo uploads are busy right now. Please try again in a few hours.",
  { keyGenerator: () => "all" }
);

// Unauthenticated endpoints that cost money or send email per call.
export const orderLimiter = limiter(
  "order",
  10 * 60 * 1000,
  30,
  "Too many payment attempts. Please try again in a few minutes."
);

export const verifyOtpLimiter = limiter("verify-otp", 10 * 60 * 1000, 20, "Too many attempts. Try again later.");

export const reportLimiter = limiter("report", 10 * 60 * 1000, 5, "Too many reports. Try again later.");

// Email / phone availability checks, to slow down account enumeration.
export const lookupLimiter = limiter("lookup", 10 * 60 * 1000, 40, "Too many requests. Try again later.");

export default otpLimiter;
