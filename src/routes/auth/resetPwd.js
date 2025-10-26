import bcrypt from "bcryptjs";
import { Router } from "express";
import transporter from "../../config/nodeMailer.js";
import redisClient from "../../config/redisClient.js";
import otpLimiter from "../../middleware/otpLimiter.js";
import User from "../../models/User.js";
import otpGenerator from "otp-generator";

const router = Router();

router.post("/request-reset", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email)
      return res.status(400).json({ success: false, msg: "Email is required" });

    const user = await User.findOne({ email });
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
    await transporter.sendMail({
      from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Password Reset OTP from Seetha Rama Kalyana",
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h3>Reset Your Password</h3>
          <p>Your OTP is:</p>
          <h2>${otp}</h2>
          <p>This OTP is valid for <b>5 minutes</b>.</p>
          <p>If you didn't request this, please ignore this email.</p>
        </div>
      `,
    });

    console.log(`OTP sent to ${email}: ${otp}`);
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
});

router.post("/reset-password", async (req, res) => {
  const { email, newPassword } = req.body;

  const verified = await redisClient.get(`otp_verified:${email}`);
  if (!verified)
    return res
      .status(400)
      .json({ success: false, msg: "OTP not verified or expired" });

  const hashed = await bcrypt.hash(newPassword, 10);
  await User.findOneAndUpdate({ email }, { password: hashed });

  await redisClient.del(`otp_verified:${email}`);

  res.json({ success: true, msg: "Password reset successful" });
});

export default router;
