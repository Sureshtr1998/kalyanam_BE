import { Redis } from "@upstash/redis";
import fetch from "node-fetch";

// Upstash Redis client
export const upStash = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Publish a delayed QStash job
 * @param {string} endpoint - Full URL of your API endpoint
 * @param {object} payload - JSON payload to send
 * @param {string} delay - Delay in seconds, e.g., "20s"
 */
export const publishQStash = async (endpoint, payload, delay = "20s") => {
  if (!process.env.QSTASH_TOKEN) throw new Error("QSTASH_TOKEN not set");

  const res = await fetch(
    `https://qstash.upstash.io/v2/publish/${process.env.BASE_URL}${endpoint}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
        "Upstash-Delay": delay,
        "Upstash-Forward-x-internal-secret": process.env.INTERNAL_ROUTE_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QStash publish failed: ${res.status} ${text}`);
  }

  return res.json();
};

export default upStash;
