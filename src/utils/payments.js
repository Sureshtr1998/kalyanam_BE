import crypto from "crypto";
import upStash from "../config/upStash.js";

// Paid-order records live in Redis keyed by Razorpay order id. They are the
// source of truth for what a payment buys (amount, interests, form data), so
// nothing the browser sends after checkout can change it.
const ORDER_PREFIX = "rzp_order:";
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 3;

export class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

export const saveOrder = (orderId, record) =>
  upStash.set(`${ORDER_PREFIX}${orderId}`, JSON.stringify(record), {
    ex: ORDER_TTL_SECONDS,
  });

export const getOrder = async (orderId) => {
  if (!orderId || typeof orderId !== "string") return null;
  const raw = await upStash.get(`${ORDER_PREFIX}${orderId}`);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
};

export const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

export const isValidCheckoutSignature = (orderId, paymentId, signature) => {
  if (!orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeEqual(expected, signature);
};

export const isValidWebhookSignature = (rawBody, signature) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return safeEqual(expected, signature);
};

export const isInternalRequest = (req) =>
  !!process.env.INTERNAL_ROUTE_SECRET &&
  safeEqual(req.header("x-internal-secret"), process.env.INTERNAL_ROUTE_SECRET);

/**
 * Authenticates a fulfilment call and loads the order it pays for.
 * Browser calls must carry a valid Razorpay checkout signature; QStash
 * fallback calls (triggered by the verified webhook) carry the internal secret.
 */
export const resolvePaidOrder = async (req, purpose) => {
  const { orderId, paymentId, signature } = req.body || {};
  if (!orderId || !paymentId) {
    throw new HttpError(400, "Missing payment details");
  }
  if (
    !isInternalRequest(req) &&
    !isValidCheckoutSignature(orderId, paymentId, signature)
  ) {
    throw new HttpError(400, "Payment verification failed");
  }
  const record = await getOrder(orderId);
  if (!record) {
    throw new HttpError(
      404,
      `We could not find this order. Please contact support with payment ID ${paymentId}.`
    );
  }
  if (record.purpose !== purpose) {
    throw new HttpError(400, "This payment does not belong to this action");
  }
  return { record, orderId, paymentId };
};

export const sendHttpError = (res, err, fallbackMsg = "Server error") => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, msg: err.message });
  }
  console.error(err);
  return res.status(500).json({ success: false, msg: fallbackMsg });
};
