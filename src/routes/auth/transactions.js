import { Router } from "express";
import axios from "axios";
import { nanoid } from "nanoid";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import sendEmail from "../../config/msg91Email.js";
import { Cashfree, CFEnvironment } from "cashfree-pg";
import cf from "../../config/cashfree.js";

const router = Router();

router.post("/create-order", async (req, res) => {
  const { userName, userEmail, userPhone, amount } = req.body;

  try {
    const orderId = "order_" + nanoid();

    const payload = {
      orderId: "order_" + nanoid(),
      order_amount: Number(amount),
      order_currency: "INR",
      order_note: "Matrimony subscription",
      payment_modes: ["UPI_QR"],
      customer_details: {
        customer_id: `user_${userPhone}`,
        customer_name: userName,
        customer_email: userEmail,
        customer_phone: `+91${userPhone}`,
      },
    };

    const order = await cf.PGCreateOrder(payload);

    return res.json({
      orderId,
      cftoken: order.data.payment_session_id,
    });
  } catch (err) {
    console.error("Error creating order:", err);
    return res.status(500).json({ error: "Failed to create order" });
  }
});

router.post("/buy-interest", auth, async (req, res) => {
  try {
    // @ts-ignore
    const user = await User.findById(req.user.id);

    const { noOfInterest, orderId, amount, note } = req.body;

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    const increment = Number(noOfInterest) || 0;

    user.interests.totalNoOfInterest =
      (Number(user.interests.totalNoOfInterest) || 0) + increment;

    user.transactions.push({
      orderId,
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
