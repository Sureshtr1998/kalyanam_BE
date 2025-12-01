import { Router } from "express";
import axios from "axios";
import { nanoid } from "nanoid";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import sendEmail from "../../config/msg91Email.js";
import razorpay from "../../config/razorpay.js";
import dbConnect from "../../utils/dbConnect.js";

const router = Router();

router.post("/create-order", async (req, res) => {
  const { userName, userEmail, userPhone, amount } = req.body;

  try {
    await dbConnect();

    const receiptId = "order_" + nanoid();

    const options = {
      amount: Number(amount) * 100,
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

router.post("/buy-interest", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const user = await User.findById(req.user.id);

    const { noOfInterest, orderId, amount, note, paymentId } = req.body;

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    const increment = Number(noOfInterest) || 0;

    user.interests.totalNoOfInterest =
      (Number(user.interests.totalNoOfInterest) || 0) + increment;

    user.transactions.push({
      orderId,
      paymentId,
      dateOfTrans: new Date(),
      amountPaid: amount,
      noOfInterest: noOfInterest,
      note,
    });

    await user.save();

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
