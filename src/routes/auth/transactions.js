import { Router } from "express";
import { nanoid } from "nanoid";
import { auth, optionalAuth } from "../../middleware/auth.js";
import { orderLimiter } from "../../middleware/otpLimiter.js";
import User from "../../models/User.js";
import { notify } from "../../config/msg91Email.js";
import razorpay from "../../config/razorpay.js";
import { publishQStash } from "../../config/upStash.js";
import { isTestPayer } from "../../utils/constants.js";
import { getPricing } from "../../utils/pricing.js";
import {
  markCheckoutFailed,
  markCheckoutPaid,
  recordCheckout,
} from "../../utils/abandoned.js";
import {
  HttpError,
  getOrder,
  isValidWebhookSignature,
  resolvePaidOrder,
  saveOrder,
  sendHttpError,
} from "../../utils/payments.js";
import {
  buildAstroOrder,
  buildBrokerOrder,
  buildInterestOrder,
  buildRegistrationOrder,
} from "../../utils/orderBuilders.js";

const router = Router();

// Where the webhook fallback should deliver each kind of paid order.
const FULFILMENT_ENDPOINT = {
  registration: "user-register",
  interest: "buy-interest",
  astro: "astro-data",
  broker: "broker-register",
};

/** Live prices, for display. What is charged is still decided in /create-order. */
router.get("/pricing", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return res.json(await getPricing());
  } catch (err) {
    console.error("Pricing error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * Creates a Razorpay order. The amount and what it buys are decided here from
 * `purpose` (+ pack / consultation mode); any amount sent by the client is ignored.
 */
router.post("/create-order", orderLimiter, optionalAuth, async (req, res) => {
  const { purpose } = req.body || {};
  try {
    let record;
    if (purpose === "registration") {
      record = await buildRegistrationOrder(req.body.registration || {});
    } else if (purpose === "broker") {
      record = await buildBrokerOrder(req.body.broker || {});
    } else {
      // @ts-ignore
      const user = req.user;
      if (!user) throw new HttpError(401, "Please log in again");
      if (purpose === "interest") {
        record = await buildInterestOrder(user, req.body.pack);
      } else if (purpose === "astro") {
        record = await buildAstroOrder(user, req.body.astro);
      } else {
        throw new HttpError(400, "Unknown payment type");
      }
    }
    // Pricing level 1: registration is free and goes straight to /user-register.
    if (!(record.amount > 0)) {
      throw new HttpError(400, "Registration is free right now. Please refresh the page and register again.");
    }

    // Admins and test payers are charged ₹1 for anything (live testing).
    // @ts-ignore
    const isTester = !!req.user?.isAdmin || isTestPayer(record.email);
    const amountCharged = isTester ? 1 : record.amount;
    const order = await razorpay.orders.create({
      amount: amountCharged * 100,
      currency: "INR",
      receipt: "order_" + nanoid(),
      notes: {
        customer_name: record.name,
        customer_email: record.email,
        customer_phone: record.phone,
        purpose: record.purpose,
        order_note: "Matrimony subscription",
      },
    });

    await saveOrder(order.id, {
      ...record,
      orderId: order.id,
      amountCharged,
      createdAt: Date.now(),
    });
    // Kept until they pay, for the admin panel's "Abandoned" win-back list.
    await recordCheckout({ ...record, orderId: order.id }, amountCharged);

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      userName: record.name,
      userEmail: record.email,
      userPhone: record.phone,
    });
  } catch (err) {
    if (!(err instanceof HttpError)) {
      console.error("Error creating Razorpay order:", err);
    }
    return sendHttpError(res, err, "Failed to create order");
  }
});

/**
 * Razorpay webhook (configure for `payment.captured`, `payment.failed` and
 * `order.paid` with a secret set in RAZORPAY_WEBHOOK_SECRET). If the browser
 * never reported back (closed tab, network drop), `payment.captured` queues the
 * same fulfilment the browser would have done. The other two only update the
 * abandoned-checkout list.
 */
router.post("/razorpay-webhook", async (req, res) => {
  try {
    if (
      // @ts-ignore
      !isValidWebhookSignature(req.rawBody, req.header("x-razorpay-signature"))
    ) {
      return res.status(400).json({ status: "invalid signature" });
    }

    const event = req.body?.event;
    const payment = req.body?.payload?.payment?.entity;
    if (event === "payment.failed") {
      await markCheckoutFailed(
        payment?.order_id,
        payment?.error_description || payment?.error_reason
      );
      return res.status(200).json({ status: "recorded" });
    }
    if (event === "order.paid") {
      await markCheckoutPaid(req.body?.payload?.order?.entity?.id ?? payment?.order_id);
      return res.status(200).json({ status: "recorded" });
    }
    if (event !== "payment.captured" || !payment?.order_id) {
      return res.status(200).json({ status: "ignored" });
    }
    await markCheckoutPaid(payment.order_id);

    const record = await getOrder(payment.order_id);
    if (!record || record.fulfilled) {
      return res.status(200).json({ status: "nothing to do" });
    }

    // Give the browser flow a head start; fulfilment is idempotent either way.
    await publishQStash(FULFILMENT_ENDPOINT[record.purpose], {
      orderId: payment.order_id,
      paymentId: payment.id,
      email: record.email,
    });

    return res.status(200).json({ status: "queued" });
  } catch (err) {
    console.error("Webhook error:", err);
    // A 5xx makes Razorpay retry, which is what we want here.
    return res.status(500).json({ status: "error" });
  }
});

router.post("/buy-interest", auth, async (req, res) => {
  try {
    const { record, orderId, paymentId } = await resolvePaidOrder(
      req,
      "interest"
    );
    // @ts-ignore
    const userId = req.user.id;
    // @ts-ignore
    if (record.email !== req.user.basic.email) {
      throw new HttpError(403, "This payment belongs to a different account");
    }

    // Conditional update: applying the same order twice (browser + webhook) is a no-op.
    const result = await User.updateOne(
      { _id: userId, "transactions.orderId": { $ne: orderId } },
      {
        $inc: { "interests.totalNoOfInterest": record.interests },
        $push: {
          transactions: {
            $each: [
              {
                orderId,
                paymentId,
                amountPaid: record.amountCharged,
                noOfInterest: record.interests,
                note: record.note,
              },
            ],
            $position: 0,
          },
        },
      }
    );

    if (result.modifiedCount) {
      await saveOrder(orderId, { ...record, fulfilled: true, paymentId });
      notify({
        to: [{ email: record.email }],
        template_id: "purchase_interest",
        variables: {
          userName: record.name || "",
          orderId,
          paymentId,
          amount: record.amountCharged,
          numInterests: record.interests,
        },
      });
    }

    const profile = await User.findById(userId).select("-basic.password").lean();
    return res.json({ profile, alreadyApplied: !result.modifiedCount });
  } catch (err) {
    return sendHttpError(res, err, "Could not apply your purchase");
  }
});

export default router;
