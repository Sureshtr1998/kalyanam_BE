import { Router } from "express";
import otpGenerator from "otp-generator";
import transporter from "../../config/nodeMailer.js";
import redisClient from "../../config/redisClient.js";
import twilioClient from "../../config/twilio.js";

const router = Router();

router.post("/send-otp", async (req, res) => {
  const { email, mobile } = req.body;
  if (!email || !mobile)
    return res
      .status(400)
      .json({ success: false, msg: "Email and mobile are required" });

  const emailOtp = otpGenerator.generate(6, {
    upperCaseAlphabets: false,
    specialChars: false,
    lowerCaseAlphabets: false,
  });
  const mobileOtp = otpGenerator.generate(6, {
    upperCaseAlphabets: false,
    specialChars: false,
    lowerCaseAlphabets: false,
  });

  const otpRecord = {
    emailOtp,
    mobileOtp,
    mobile,
    expires: Date.now() + 5 * 60 * 1000, // 5 min
  };

  try {
    // Save to Redis with TTL of 5 minutes
    await redisClient.set(`otp:${email}`, JSON.stringify(otpRecord), {
      EX: 300,
    });

    // Send Email OTP
    await transporter.sendMail({
      from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Email OTP Verification - Seetha Rama Kalyana",
      html: `<p>Your email OTP is <b>${emailOtp}</b> (valid for 5 minutes).</p>`,
    });

    // Send SMS OTP
    await twilioClient.messages.create({
      body: `Your mobile OTP is ${mobileOtp}. Valid for 5 minutes.`,
      from: process.env.TWILIO_PHONE,
      to: `+91${mobile}`,
    });

    res.json({ success: true, msg: "OTP sent to email and mobile" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Failed to send OTP" });
  }
});

router.post("/verify-otp-registration", async (req, res) => {
  const { email, emailOtp, mobileOtp } = req.body;

  try {
    const recordStr = await redisClient.get(`otp:${email}`);
    if (!recordStr)
      return res
        .status(400)
        .json({ success: false, msg: "OTP not found or expired" });

    // @ts-ignore
    const record = JSON.parse(recordStr);

    if (record.emailOtp !== emailOtp)
      return res.status(400).json({ success: false, msg: "Invalid email OTP" });

    if (record.mobileOtp !== mobileOtp)
      return res.status(400).json({ success: false, msg: "Invalid phone OTP" });

    // OTPs verified → remove from Redis
    await redisClient.del(`otp:${email}`);

    // ✅ Continue registration / mark user verified
    res.json({ success: true, msg: "Email and phone verified successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
