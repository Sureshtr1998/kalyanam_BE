import bcrypt from "bcryptjs";
import { Router } from "express";
import upStash from "../../config/upStash.js";
import otpLimiter from "../../middleware/otpLimiter.js";
import User from "../../models/User.js";
import otpGenerator from "otp-generator";
import sendEmail from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";
import Broker from "../../models/Broker.js";

const router = Router();

router.post("/request-reset", otpLimiter, async (req, res) => {
  try {
    await dbConnect();

    const { email, isPartner } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, msg: "Email is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    let account;

    if (isPartner) {
      account = await Broker.findOne({ email: normalizedEmail });
    } else {
      account = await User.findOne({ "basic.email": normalizedEmail });
    }

    if (!account) {
      return res.status(404).json({
        success: false,
        msg: isPartner ? "Partner not found" : "User not found",
      });
    }

    const otp = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      lowerCaseAlphabets: false,
      specialChars: false,
    });

    await upStash.set(`otp:${email}`, otp, { ex: 300 }); // 5 minutes

    await sendEmail({
      to: [{ email: normalizedEmail }],
      template_id: "password_reset_28",
      variables: {
        otp,
      },
    });

    return res.json({
      success: true,
      msg: "OTP sent to your registered email",
    });
  } catch (err) {
    console.error("Request reset error:", err);
    res.status(500).json({
      success: false,
      msg: "Server error",
    });
  }
});

router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  try {
    await dbConnect();

    const storedOtp = await upStash.get(`otp:${email}`);

    if (!storedOtp)
      return res
        .status(400)
        .json({ success: false, msg: "OTP not found or expired" });

    if (String(storedOtp) !== String(otp))
      return res.status(400).json({ success: false, msg: "Invalid OTP" });

    // Delete old OTP and mark as verified
    await upStash.del(`otp:${email}`);
    await upStash.set(`otp_verified:${email}`, "true", { ex: 600 });

    res.json({ success: true, msg: "OTP verified successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});
router.post("/reset-password", async (req, res) => {
  const { email, newPassword, isPartner } = req.body;

  if (!email || !newPassword) {
    return res
      .status(400)
      .json({ success: false, msg: "Email and new password are required" });
  }

  try {
    await dbConnect();

    const verified = await upStash.get(`otp_verified:${email}`);
    if (!verified) {
      return res
        .status(400)
        .json({ success: false, msg: "OTP not verified or expired" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    if (isPartner) {
      // 🔐 Reset Broker password
      const broker = await Broker.findOneAndUpdate(
        { email: email.toLowerCase().trim() },
        { password: hashedPassword }
      );

      if (!broker) {
        return res
          .status(404)
          .json({ success: false, msg: "Partner not found" });
      }
    } else {
      // 🔐 Reset User password
      const user = await User.findOneAndUpdate(
        { "basic.email": email.toLowerCase().trim() },
        { "basic.password": hashedPassword }
      );

      if (!user) {
        return res.status(404).json({ success: false, msg: "User not found" });
      }
    }

    await upStash.del(`otp_verified:${email}`);

    res.json({
      success: true,
      msg: "Password reset successful",
    });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
