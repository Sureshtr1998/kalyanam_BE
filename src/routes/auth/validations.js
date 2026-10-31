import { Router } from "express";
import otpGenerator from "otp-generator";
import sendEmail from "../../config/msg91Email.js";
import upStash from "../../config/upStash.js";
import sendWhatsappOTP from "../../config/msg91Whatsapp.js";
import User from "../../models/User.js";
import otpLimiter, { countHit } from "../../middleware/otpLimiter.js";
import dbConnect from "../../utils/dbConnect.js";
import { auth } from "../../middleware/auth.js";
import {
  EMAIL_RE,
  MOBILE_RE,
  normalizeEmail,
} from "../../utils/constants.js";

const router = Router();
const MAX_OTP_ATTEMPTS = 5;
// OTP sends (one email + one WhatsApp each) per member per hour.
const MAX_SENDS_PER_HOUR = 5;

const newOtp = () =>
  otpGenerator.generate(6, {
    upperCaseAlphabets: false,
    specialChars: false,
    lowerCaseAlphabets: false,
  });

router.post("/send-otp", otpLimiter, auth, async (req, res) => {
  // @ts-ignore
  const userId = req.user.id;
  const email = normalizeEmail(req.body?.email);
  const mobile = String(req.body?.mobile || "");
  if (!EMAIL_RE.test(email) || !MOBILE_RE.test(mobile))
    return res.status(400).json({
      success: false,
      msg: "Enter a valid email and 10-digit WhatsApp number",
    });

  try {
    if ((await countHit(`send-otp:${userId}`, 60 * 60 * 1000)) > MAX_SENDS_PER_HOUR) {
      return res.status(429).json({ success: false, msg: "Too many codes sent. Please try again in an hour." });
    }
    await dbConnect();

    const existingEmail = await User.exists({
      "basic.email": email,
      _id: { $ne: userId },
    });

    if (existingEmail) {
      return res.status(400).json({ msg: "Email already registered" });
    }

    const existingMobile = await User.exists({
      "basic.mobile": mobile,
      _id: { $ne: userId },
    });

    if (existingMobile) {
      return res.status(400).json({ msg: "Mobile number already registered" });
    }

    const otpRecord = {
      emailOtp: newOtp(),
      mobileOtp: newOtp(),
      email,
      mobile,
      attempts: 0,
    };

    // Save to Redis with TTL of 5 minutes
    await upStash.set(`reg_otp:${userId}`, JSON.stringify(otpRecord), {
      ex: 300,
    });

    // Send Email OTP
    await sendEmail({
      to: [{ email: email }],
      template_id: "otp_verify_2", // MSG91 Template ID
      variables: {
        otp: otpRecord.emailOtp,
      },
    });
    // Send WhatsApp OTP
    await sendWhatsappOTP(`91${mobile}`, otpRecord.mobileOtp);

    res.json({ success: true, msg: "OTP sent to email and WhatsApp" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Failed to send OTP" });
  }
});

router.post("/verify-otp-registration", auth, async (req, res) => {
  // @ts-ignore
  const userId = req.user.id;
  const { emailOtp, mobileOtp } = req.body || {};

  try {
    await dbConnect();

    const key = `reg_otp:${userId}`;
    const record = await upStash.get(key);
    if (!record)
      return res
        .status(400)
        .json({ success: false, msg: "OTP not found or expired" });

    const emailOk = String(record.emailOtp) === String(emailOtp);
    const mobileOk = String(record.mobileOtp) === String(mobileOtp);
    if (!emailOk || !mobileOk) {
      const attempts = (record.attempts || 0) + 1;
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await upStash.del(key);
        return res.status(400).json({
          success: false,
          msg: "Too many wrong attempts. Please request new OTPs.",
        });
      }
      await upStash.set(key, JSON.stringify({ ...record, attempts }), {
        keepTtl: true,
      });
      return res.status(400).json({
        success: false,
        msg: !emailOk ? "Invalid email OTP" : "Invalid WhatsApp OTP",
      });
    }

    // OTPs verified → remove from Redis and let the next profile save
    // apply this exact email + number.
    await upStash.del(key);
    await upStash.set(
      `contact_verified:${userId}`,
      JSON.stringify({ email: record.email, mobile: record.mobile }),
      { ex: 3600 }
    );

    res.json({ success: true, msg: "Email and phone verified successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
