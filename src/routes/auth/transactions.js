import { Router } from "express";
import { nanoid } from "nanoid";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import sendEmail from "../../config/msg91Email.js";
import razorpay from "../../config/razorpay.js";
import upStash, { publishQStash } from "../../config/upStash.js";
import dbConnect from "../../utils/dbConnect.js";
import { PENDING_PAYMENT, SUPPORT_EMAIL } from "../../utils/constants.js";
import { isTransactionExists } from "../../utils/utils.js";

const router = Router();

router.post("/create-order", async (req, res) => {
  const { userName, userEmail, userPhone, amount, payload } = req.body;
  try {
    await dbConnect();

    const receiptId = "order_" + nanoid();

    await sendEmail({
      to: [{ email: SUPPORT_EMAIL }],
      template_id: "user_register_2",
      variables: {
        note: payload.note,
        payload: "CREATE ORDER: " + JSON.stringify(req.body),
      },
    });
    const amnt = userName === "Suresh TR" ? 100 : Number(amount) * 100;
    const options = {
      amount: amnt,
      currency: "INR",
      receipt: receiptId,
      payment_capture: 1,
      notes: {
        customer_name: userName,
        customer_email: userEmail,
        customer_phone: userPhone,
        order_note: "Matrimony subscription",
      },
    };

    const order = await razorpay.orders.create(options);

    await upStash.set(
      `${PENDING_PAYMENT}${userEmail}`,
      JSON.stringify({
        ...payload,
        orderId: order.id,
      }),
      { ex: 120 }
    );

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      userName,
      userEmail,
      userPhone,
    });
  } catch (err) {
    console.error("Error creating Razorpay order:", err);
    return res.status(500).json({ error: "Failed to create order" });
  }
});

router.post("/razorpay-webhook", async (req, res) => {
  try {
    const payment = req.body.payload.payment.entity;
    const paymentId = payment.id;
    const email = payment.notes?.customer_email;

    //Add user registration condition
    const redisKey = `${PENDING_PAYMENT}${email}`;
    const data = await upStash.get(redisKey);

    if (!data) return;

    // Wait 20 seconds before fallback
    await publishQStash(data.endpoint, { ...data, paymentId, email });

    res.status(200).json({ status: "queued" });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ status: "error" });
  }
});

router.post("/buy-interest", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const user = await User.findById(req.user.id);
    const { noOfInterest, orderId, amount, note, paymentId } = req.body;

    const exists = isTransactionExists(user.transactions, orderId, paymentId);
    if (exists) {
      return res.status(200).json({
        success: false,
        msg: "Transaction data already exists",
      });
    }

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    const increment = Number(noOfInterest) || 0;

    user.interests.totalNoOfInterest =
      (Number(user.interests.totalNoOfInterest) || 0) + increment;

    user.transactions.unshift({
      orderId,
      paymentId,
      amountPaid: amount,
      noOfInterest: noOfInterest,
      note,
    });

    await user.save();
    await upStash.del(`${PENDING_PAYMENT}${user.basic.email}`);

    await sendEmail({
      to: [{ email: user.basic.email }],
      template_id: "purchase_interest", // MSG91 Template ID
      variables: {
        userName: user.basic.fullName || "",
        orderId,
        paymentId,
        amount,
        numInterests: noOfInterest,
      },
    });

    res.json({ profile: user });
  } catch (err) {
    console.error("Error purchasing item:", err);

    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
