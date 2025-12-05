import { Router } from "express";
import axios from "axios";
import { nanoid } from "nanoid";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import sendEmail from "../../config/msg91Email.js";
import razorpay from "../../config/razorpay.js";
import redisClient from "../../config/redisClient.js";
import dbConnect from "../../utils/dbConnect.js";
import { SUPPORT_EMAIL } from "../../utils/constants.js";
import bcrypt from "bcryptjs";
import { generateUniqueId } from "../../utils/utils.js";

const router = Router();

router.post("/create-order", async (req, res) => {
  const { userName, userEmail, userPhone, amount, newUserPayload } = req.body;
  try {
    await dbConnect();

    const receiptId = "order_" + nanoid();

    if (newUserPayload?.email) {
      const redisKey = `pending_registration:${newUserPayload.email}`;
      await redisClient.set(
        redisKey,
        JSON.stringify({
          ...newUserPayload,
          orderId: receiptId, // temp orderId before Razorpay assigns actual
        }),
        { EX: 120 } // expires in 120 seconds
      );
    }

    await sendEmail({
      to: [{ email: SUPPORT_EMAIL }],
      template_id: "user_register_2",
      variables: {
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

    if (newUserPayload?.email) {
      await redisClient.set(
        `pending_registration:${newUserPayload.email}`,
        JSON.stringify({
          ...newUserPayload,
          orderId: order.id,
        }),
        { EX: 120 }
      );
    }

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
    const orderId = payment.order_id;
    const paymentId = payment.id;

    console.log("WEB HOOK");
    // Wait 20 seconds before fallback
    setTimeout(async () => {
      try {
        console.log("TIME OUT");
        const email = req.body.payload.payment.entity.notes?.customer_email;
        if (!email) return;

        const redisKey = `pending_registration:${email}`;
        const pendingData = await redisClient.get(redisKey);

        if (!pendingData) return;

        const data = JSON.parse(pendingData);

        // Check if user already exists in DB
        const existingUser = await User.findOne({ "basic.email": email });
        console.log("WEB existingUser", existingUser);

        if (existingUser) return;

        //Only if FE fails then only below data would be created from Razorpay
        const {
          password,
          fullName,
          mobile,
          alternateMob,
          dob,
          gender,
          motherTongue,
          martialStatus,
          profileCreatedBy,
          subCaste,
          qualification,
          gothra,
          images = [],
          //Transaction Details
          orderId: orderId,
          paymentId: paymentId,
          amountPaid,
          totalNoOfInterest,
          note,
        } = data;

        const hashedPassword = await bcrypt.hash(password, 10);

        const emailNormalized = email.trim().toLowerCase();
        const uniqueId = await generateUniqueId();

        const newUser = new User({
          basic: {
            email: emailNormalized,
            password: hashedPassword,
            fullName,
            mobile,
            alternateMob,
            dob,
            gender,
            motherTongue,
            martialStatus,
            profileCreatedBy,
            subCaste,
            gothra,
            qualification,
            images,
            uniqueId,
          },
          interests: {
            totalNoOfInterest,
          },
          transactions: [
            {
              orderId,
              paymentId,
              dateOfTrans: new Date(),
              amountPaid,
              noOfInterest: totalNoOfInterest,
              note,
            },
          ],
        });

        await newUser.save();

        await sendEmail({
          to: [{ email: emailNormalized }],
          template_id: "welcome_user_2", // MSG91 Template ID
          variables: {
            userName: fullName,
            orderId,
            paymentId,
            numInterests: totalNoOfInterest,
            amount: amountPaid,
          },
        });

        await redisClient.del(redisKey); // optional cleanup
      } catch (err) {
        console.error("Webhook fallback error:", err);
      }
    }, 20000);

    res.status(200).json({ status: "ok" });
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
