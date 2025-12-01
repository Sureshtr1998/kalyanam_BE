import bcrypt from "bcryptjs";
import { Router } from "express";
import redisClient from "../../config/redisClient.js";
import otpLimiter from "../../middleware/otpLimiter.js";
import User from "../../models/User.js";
import otpGenerator from "otp-generator";
import sendEmail from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";

const router = Router();

router.post("/request-reset", otpLimiter, async (req, res) => {
  try {
    await dbConnect();

    const { email } = req.body;
    if (!email)
      return res.status(400).json({ success: false, msg: "Email is required" });

    const user = await User.findOne({ "basic.email": email });
    if (!user)
      return res.status(404).json({ success: false, msg: "User not found" });

    // Generate 6-digit OTP
    const otp = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars: false,
      lowerCaseAlphabets: false,
    });

    // Store in Redis with expiry (5 minutes)
    await redisClient.setEx(`otp:${email}`, 300, otp);

    // Send OTP email
    await sendEmail({
      to: [{ email: email }],
      template_id: "password_reset_28", // MSG91 Template ID
      variables: {
        otp: otp,
      },
    });

    return res.json({
      success: true,
      msg: "OTP sent to your registered email",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  try {
    await dbConnect();

    const storedOtp = await redisClient.get(`otp:${email}`);

    if (!storedOtp)
      return res
        .status(400)
        .json({ success: false, msg: "OTP not found or expired" });

    if (storedOtp !== otp)
      return res.status(400).json({ success: false, msg: "Invalid OTP" });

    // Delete old OTP and mark as verified
    await redisClient.del(`otp:${email}`);
    await redisClient.setEx(`otp_verified:${email}`, 600, "true"); // valid for 10 minutes

    res.json({ success: true, msg: "OTP verified successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    await dbConnect();

    const verified = await redisClient.get(`otp_verified:${email}`);
    if (!verified)
      return res
        .status(400)
        .json({ success: false, msg: "OTP not verified or expired" });

    const hashed = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate(
      { "basic.email": email },
      { "basic.password": hashed }
    );

    await redisClient.del(`otp_verified:${email}`);

    res.json({ success: true, msg: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
