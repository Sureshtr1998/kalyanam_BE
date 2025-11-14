import { Router } from "express";
import axios from "axios";
import { nanoid } from "nanoid";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import sendEmail from "../../config/msg91Email.js";

const router = Router();

router.post("/create-order", async (req, res) => {
  const { userName, userEmail, userPhone, amount } = req.body;

  try {
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

    const response = await axios.post(
      `${process.env.CF_BASE_URL}/pg/orders`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "x-client-id": process.env.CF_APP_ID,
          "x-client-secret": process.env.CF_SECRET_KEY,
          "x-api-version": "2022-01-01",
        },
      }
    );
    const payment_link = response.data.payment_link;

    return res.status(200).json({
      paymentLink: payment_link,
      orderId: response.data.order_id,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create QR order" });
  }
});

router.get("/check-payment-status/:orderId", async (req, res) => {
  const { orderId } = req.params;

  try {
    const response = await axios.get(
      `${process.env.CF_BASE_URL}/pg/orders/${orderId}/payments`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-client-id": process.env.CF_APP_ID,
          "x-client-secret": process.env.CF_SECRET_KEY,
          "x-api-version": "2022-01-01",
        },
      }
    );
    const order_status =
      response.data[response.data.length - 1]?.payment_status;

    return res.status(200).json({
      orderId: orderId,
      status: order_status, // "NOT_ATTEMPTED", "FAILED", "SUCCESS", etc.
    });
  } catch (err) {
    console.error(
      `Error checking status for ${orderId}:`,
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Failed to fetch order status" });
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

    user.interests.totalNoOfInterest =
      user.interests.totalNoOfInterest + noOfInterest;

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
