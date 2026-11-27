import { Router } from "express";
import otpGenerator from "otp-generator";
import sendEmail from "../../config/msg91Email.js";
import upStash, { publishQStash } from "../../config/upStash.js";
import sendWhatsappOTP from "../../config/msg91Whatsapp.js";
import { flowFailed, flowOk } from "../../ops/health.js";
import User from "../../models/User.js";
import otpLimiter, { countHit } from "../../middleware/otpLimiter.js";
import dbConnect from "../../utils/dbConnect.js";
import { auth } from "../../middleware/auth.js";
import {
  EMAIL_RE,
  MOBILE_RE,
  normalizeEmail,
} from "../../utils/constants.js";
import { isInternalRequest } from "../../utils/payments.js";
import { AUTO_VERIFY_DELAY, autoVerifyDue, autoVerifyIfDue } from "../../utils/autoVerify.js";

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
    await flowOk("otp");

    res.json({ success: true, msg: "OTP sent to email and WhatsApp" });
  } catch (err) {
    console.error(err);
    // Several failures in a row = registration is broken: the owner hears on WhatsApp.
    await flowFailed("otp", err);
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

/**
 * The member couldn't get or enter the OTP codes and copied the help message
 * (OtpVerifyDialog). Records the details they want verified and queues a check
 * 4 hours later; if the admin's auto-verify mode is on then, they're verified.
 */
router.post("/verification-help", auth, async (req, res) => {
  // @ts-ignore
  const userId = req.user.id;
  const email = normalizeEmail(req.body?.email);
  const mobile = String(req.body?.mobile || "");
  if (!EMAIL_RE.test(email) || !MOBILE_RE.test(mobile))
    return res.status(400).json({ msg: "Enter a valid email and 10-digit WhatsApp number" });

  try {
    await dbConnect();
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: "User not found" });
    if (user.isVerified) return res.json({ msg: "Already verified" });

    if (await User.exists({ "basic.email": email, _id: { $ne: userId } }))
      return res.status(400).json({ msg: "Email already registered" });
    if (await User.exists({ "basic.mobile": mobile, _id: { $ne: userId } }))
      return res.status(400).json({ msg: "Mobile number already registered" });

    // The clock starts at the first request; later requests only update the details.
    const first = !user.verifyHelp?.at;
    user.verifyHelp = { at: user.verifyHelp?.at ?? new Date(), email, mobile };
    await user.save();

    if (first) {
      try {
        await publishQStash("auto-verify", { userId: String(user._id) }, AUTO_VERIFY_DELAY);
      } catch (err) {
        // Not fatal: the next profile save or admin visit catches it too.
        console.error("Auto-verify queue error:", err);
      }
    }
    return res.json({ msg: "We've noted your request for help." });
  } catch (err) {
    console.error("Verification help error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/** QStash, 4 hours after a help request: verifies that member (and anyone else due) if the mode is on. */
router.post("/auto-verify", async (req, res) => {
  if (!isInternalRequest(req)) return res.status(404).json({ msg: "Not found" });
  try {
    await dbConnect();
    const user = req.body?.userId ? await User.findById(String(req.body.userId)) : null;
    const one = user ? await autoVerifyIfDue(user) : false;
    const others = await autoVerifyDue();
    return res.json({ verified: one, alsoVerified: others });
  } catch (err) {
    console.error("Auto-verify error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

export default router;
