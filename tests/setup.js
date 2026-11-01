// Runs before every test file: points the app at an in-memory MongoDB and
// fake config, and replaces every external service with an in-process fake.
import path from "node:path";
import { afterAll, beforeEach, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

// src/config/env.js loads .env through dotenv/config; send it to the fake file
// so a developer's real keys are never picked up by tests.
process.env.DOTENV_CONFIG_PATH = path.resolve(import.meta.dirname, ".env.test");
process.env.DOTENV_CONFIG_QUIET = "true";
const { config } = await import("dotenv");
config({ path: process.env.DOTENV_CONFIG_PATH, override: true, quiet: true });

const mongo = await MongoMemoryServer.create();
process.env.MONGO_URI = mongo.getUri("kalyanam_test");

// --- Fakes ---------------------------------------------------------------

/** Minimal Upstash Redis: string values, JSON auto-deserialised like the real client. */
const redis = new Map();
export const fakeRedis = {
  store: redis,
  get: vi.fn(async (key) => {
    const raw = redis.get(key);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }),
  set: vi.fn(async (key, value) => {
    redis.set(key, typeof value === "string" ? value : JSON.stringify(value));
    return "OK";
  }),
  del: vi.fn(async (key) => (redis.delete(key) ? 1 : 0)),
  // Rate-limit counters (src/middleware/otpLimiter.js) are kept here as
  // { hits, resetAt }; `eval` stands in for its increment script.
  decr: vi.fn(async (key) => {
    const entry = redis.get(key);
    if (!entry) return -1;
    const counter = JSON.parse(entry);
    counter.hits -= 1;
    redis.set(key, JSON.stringify(counter));
    return counter.hits;
  }),
  eval: vi.fn(async (_script, [key], [windowMs]) => {
    const now = Date.now();
    const entry = redis.get(key);
    const { hits, resetAt } = entry ? JSON.parse(entry) : { hits: 0, resetAt: 0 };
    const fresh = resetAt <= now;
    const next = { hits: fresh ? 1 : hits + 1, resetAt: fresh ? now + Number(windowMs) : resetAt };
    redis.set(key, JSON.stringify(next));
    return [next.hits, next.resetAt - now];
  }),
};

vi.mock("../src/config/upStash.js", () => ({
  default: fakeRedis,
  upStash: fakeRedis,
  publishQStash: vi.fn(async () => ({ messageId: "msg_test" })),
}));

let orderSeq = 0;
vi.mock("../src/config/razorpay.js", () => ({
  default: {
    orders: {
      create: vi.fn(async ({ amount, currency }) => ({
        id: `order_test_${++orderSeq}`,
        amount,
        currency,
      })),
    },
    payments: {
      refund: vi.fn(async (paymentId) => ({ id: `rfnd_${paymentId}`, amount: undefined })),
    },
  },
}));

vi.mock("../src/config/msg91Email.js", () => ({
  default: vi.fn(async () => ({})),
  notify: vi.fn(async () => {}),
}));

vi.mock("../src/config/imageKit.js", () => ({
  default: { deleteFile: vi.fn(async () => ({})), upload: vi.fn() },
}));

vi.mock("../src/config/msg91Whatsapp.js", () => ({ default: vi.fn(async () => ({})) }));

vi.mock("../src/utils/utils.js", async (importOriginal) => ({
  ...(await importOriginal()),
  uploadToImageKit: vi.fn(async (_buf, name) => ({
    url: `https://ik.example.test/${name}`,
    fileId: `file_${name}`,
  })),
}));

// --- Lifecycle -------------------------------------------------------------

beforeEach(async () => {
  redis.clear();
  vi.clearAllMocks();
  if (mongoose.connection.readyState === 1) {
    await Promise.all(
      Object.values(mongoose.connection.collections).map((c) => c.deleteMany({}))
    );
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  global.mongoose = undefined;
  await mongo.stop();
});
