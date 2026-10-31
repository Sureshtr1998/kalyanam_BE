import bcrypt from "bcryptjs";
import { Router } from "express";
import upStash from "../../config/upStash.js";
import otpLimiter, { countHit, verifyOtpLimiter } from "../../middleware/otpLimiter.js";
import User from "../../models/User.js";
import Broker from "../../models/Broker.js";
import otpGenerator from "otp-generator";
import sendEmail from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";
import { PASSWORD_RULE_MSG, isValidPassword, normalizeEmail } from "../../utils/constants.js";

const router = Router();
const MAX_OTP_ATTEMPTS = 5;
// Reset emails per address per hour, however many IPs ask.
const MAX_RESETS_PER_HOUR = 5;

// Members and matchmaker partners are separate accounts that may share an
// email, so their reset codes are kept apart.
const scopeOf = (body) => (body?.isPartner ? "partner:" : "");

const accountExists = (isPartner, email) =>
  isPartner ? Broker.exists({ email }) : User.exists({ "basic.email": email });

router.post("/request-reset", otpLimiter, async (req, res) => {
  try {
    await dbConnect();

    const email = normalizeEmail(req.body?.email);
    if (!email)
      return res.status(400).json({ success: false, msg: "Email is required" });

    // Same answer whether or not the account exists, so this can't be used
    // to find out who is registered.
    const sent = { success: true, msg: "If an account exists for this email, we've sent it a reset code" };

    const hits = await countHit(`reset:${scopeOf(req.body)}${email}`, 60 * 60 * 1000);
    if (hits > MAX_RESETS_PER_HOUR) {
      return res.status(429).json({
        success: false,
        msg: "Too many reset requests for this email. Please try again in an hour.",
      });
    }

    if (!(await accountExists(req.body?.isPartner, email))) return res.json(sent);

    // Generate 6-digit OTP
    const otp = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars: false,
      lowerCaseAlphabets: false,
    });

    // Store in Redis with expiry (5 minutes)
    await upStash.set(
      `reset_otp:${scopeOf(req.body)}${email}`,
      JSON.stringify({ otp, attempts: 0 }),
      { ex: 300 }
    );

    // Send OTP email
    await sendEmail({
      to: [{ email: email }],
      template_id: "password_reset_28", // MSG91 Template ID
      variables: {
        otp: otp,
      },
    });

    return res.json(sent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/verify-otp", verifyOtpLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || "");
  try {
    await dbConnect();

    const scope = scopeOf(req.body);
    const key = `reset_otp:${scope}${email}`;
    const record = await upStash.get(key);

    if (!record)
      return res
        .status(400)
        .json({ success: false, msg: "OTP not found or expired" });

    if (String(record.otp) !== otp) {
      const attempts = (record.attempts || 0) + 1;
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await upStash.del(key);
        return res.status(400).json({
          success: false,
          msg: "Too many wrong attempts. Please request a new OTP.",
        });
      }
      await upStash.set(key, JSON.stringify({ ...record, attempts }), {
        keepTtl: true,
      });
      return res.status(400).json({ success: false, msg: "Invalid OTP" });
    }

    // Delete old OTP and mark as verified
    await upStash.del(key);
    await upStash.set(`otp_verified:${scope}${email}`, "true", { ex: 600 });

    res.json({ success: true, msg: "OTP verified successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/reset-password", verifyOtpLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const newPassword = req.body?.newPassword;

  try {
    await dbConnect();

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ success: false, msg: PASSWORD_RULE_MSG });
    }

    const scope = scopeOf(req.body);
    const verified = await upStash.get(`otp_verified:${scope}${email}`);
    if (!verified)
      return res
        .status(400)
        .json({ success: false, msg: "OTP not verified or expired" });

    const hashed = await bcrypt.hash(newPassword, 10);
    const updated = scope
      ? await Broker.findOneAndUpdate({ email }, { password: hashed, passwordChangedAt: new Date() })
      : await User.findOneAndUpdate(
          { "basic.email": email },
          { "basic.password": hashed, passwordChangedAt: new Date() }
        );
    if (!updated) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }
    await upStash.del(`otp_verified:${scope}${email}`);

    res.json({ success: true, msg: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
