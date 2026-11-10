import jwt from "jsonwebtoken";
import { Router } from "express";
import { generateUniqueId, uploadToImageKit } from "../../utils/utils.js";
import upload, { requireImageContent } from "../../middleware/upload.js";
import bcrypt from "bcryptjs";
import User from "../../models/User.js";
import Broker from "../../models/Broker.js";
import { expiresIn, normalizeEmail } from "../../utils/constants.js";
import { notify } from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";
import {
  anonymousUploadLimiter,
  loginLimiter,
  lookupLimiter,
  uploadLimiter,
} from "../../middleware/otpLimiter.js";
import {
  deleteUnclaimedUploads,
  rememberAnonymousUploads,
} from "../../utils/images.js";
import {
  HttpError,
  isInternalRequest,
  resolvePaidOrder,
  saveOrder,
  sendHttpError,
} from "../../utils/payments.js";
import { buildRegistrationOrder } from "../../utils/orderBuilders.js";
import { DEFAULT_STRICT } from "../../utils/matching.js";
import { markCheckoutPaid, markConverted } from "../../utils/abandoned.js";
import { newMemberReferralCode, payReferralReward } from "../../utils/referrals.js";

const router = Router();

// Presence is checked at startup in src/config/env.js.
const jwtSecret = String(process.env.JWT_SECRET);

/** @param {InstanceType<typeof User>} user */
const loginPayload = (user) => ({
  id: user._id,
  fullName: user.basic?.fullName,
  email: user.basic?.email,
  mobile: user.basic?.mobile,
  role: "USER",
  // Only decides whether the app shows the Admin link; the server checks again.
  isAdmin: !!user.isAdmin,
  token: jwt.sign({ id: user._id, role: "USER" }, jwtSecret, { expiresIn }),
});

/** @param {InstanceType<typeof Broker>} broker */
const brokerLoginPayload = (broker) => ({
  id: broker._id,
  fullName: broker.name,
  email: broker.email,
  mobile: broker.phone,
  role: "BROKER",
  token: jwt.sign({ id: broker._id, role: "BROKER" }, jwtSecret, { expiresIn }),
});

router.get("/user-validation", lookupLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    const mobile = typeof req.query.mobile === "string" ? req.query.mobile : "";

    if (!email && !mobile) {
      return res.status(400).json({ msg: "Email or Mobile is required" });
    }

    await dbConnect();

    if (email && (await User.exists({ "basic.email": email })))
      return res.status(400).json({ msg: "Email already exists" });

    if (mobile && (await User.exists({ "basic.mobile": mobile })))
      return res.status(400).json({ msg: "Mobile number already registered" });

    return res.json({ success: true, msg: "Valid" });
  } catch (err) {
    console.error("User Validation Error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

router.post(
  "/user-register/upload-images",
  uploadLimiter,
  anonymousUploadLimiter,
  upload.array("images", 3),
  requireImageContent,
  async (req, res) => {
    try {
      await dbConnect();
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ msg: "No images uploaded" });
      }

      const uploadedMedia = [];
      // @ts-ignore
      for (const file of files) {
        const result = await uploadToImageKit(file.buffer, file.originalname);
        uploadedMedia.push({ url: result.url, fileId: result.fileId });
      }
      await rememberAnonymousUploads(uploadedMedia);

      res.json({ media: uploadedMedia });
    } catch (err) {
      console.error("Image upload error:", err);
      res.status(500).json({ msg: "Image upload failed" });
    }
  },
);

/** QStash, days after a pre-sign-up upload: deletes the photos if nobody registered with them. */
router.post("/cleanup-uploads", async (req, res) => {
  if (!isInternalRequest(req))
    return res.status(404).json({ msg: "Not found" });
  try {
    await dbConnect();
    const deleted = await deleteUnclaimedUploads(req.body?.fileIds);
    return res.json({ deleted });
  } catch (err) {
    console.error("Upload cleanup error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * Builds the member document shared by paid and free registrations.
 * @param {Awaited<ReturnType<typeof buildRegistrationOrder>>["registration"]} reg
 * @param {string} uniqueId
 * @param {number} totalNoOfInterest
 * @param {{ commission?: number, referrerId?: string, referralCode: string }} extra
 *   commission: what the referring broker earns; referrerId: the member whose
 *   refer & earn code was used; referralCode: this member's own code
 */
const newMemberFrom = (reg, uniqueId, totalNoOfInterest, { commission, referrerId, referralCode }) =>
  new User({
    basic: {
      uniqueId,
      email: reg.email,
      password: reg.passwordHash,
      fullName: reg.fullName,
      mobile: reg.mobile,
      alternateMob: reg.alternateMob,
      dob: new Date(reg.dob),
      gender: reg.gender,
      motherTongue: reg.motherTongue,
      martialStatus: reg.martialStatus,
      profileCreatedBy: reg.profileCreatedBy,
      caste: reg.caste,
      subCaste: reg.subCaste,
      gothra: reg.gothra,
      qualification: reg.qualification,
      images: reg.images,
      // Partner and promo codes only; a member's code goes in referredByCode
      // so it never counts towards partner commissions.
      referralId: (!referrerId && reg.referralId) || undefined,
    },
    referralCode,
    referredBy: referrerId || undefined,
    referredByCode: (referrerId && reg.referralId) || undefined,
    // New members start out matched within their own caste and mother tongue;
    // they can widen this from their profile. Only caste hides them from others.
    partner: {
      caste: [reg.caste],
      motherTongue: [reg.motherTongue],
      strict: DEFAULT_STRICT,
    },
    interests: { totalNoOfInterest },
    commission,
  });

/**
 * Free registration (no order), only while the pricing level makes
 * registration free. Validated exactly like a paid one; the member gets that
 * level's starter credits and no transaction.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
const registerFree = async (req, res) => {
  const record = await buildRegistrationOrder(
    req.body?.registration || req.body || {},
  );
  if (record.amount > 0) {
    throw new HttpError(402, "Registration needs payment. Please refresh the page and try again.");
  }
  const reg = record.registration;
  const newUser = newMemberFrom(reg, await generateUniqueId(), record.interests, {
    commission: record.commission,
    referrerId: record.referrerId,
    referralCode: await newMemberReferralCode(reg.fullName),
  });

  try {
    await newUser.save();
  } catch (err) {
    if (/** @type {{ code?: number }} */ (err)?.code === 11000) {
      throw new HttpError(400, "Email or mobile number already registered");
    }
    throw err;
  }
  await markConverted({ email: record.email, mobile: reg.mobile });

  notify({
    to: [{ email: record.email }],
    template_id: "welcome_free_user",
    variables: { userName: reg.fullName },
  });

  return res.json(loginPayload(newUser));
};

/**
 * Completes a paid registration. The profile comes from the order record that
 * was validated before payment (see /create-order), not from this request.
 * Safe to call twice: the second call just logs the user in.
 * Without an orderId it is a free registration (see registerFree).
 */
router.post("/user-register", async (req, res) => {
  try {
    await dbConnect();
    if (!req.body?.orderId) return await registerFree(req, res);

    const { record, orderId, paymentId } = await resolvePaidOrder(
      req,
      "registration",
    );
    const reg = record.registration;

    const existing = await User.findOne({ "basic.email": record.email });
    if (existing) {
      if (existing.transactions.some((t) => t.orderId === orderId)) {
        // A retry after a call that died mid-way; the reward runs only once.
        await payReferralReward({ referrerId: record.referrerId, friend: existing, amount: record.referralReward });
        return res.json(loginPayload(existing));
      }
      throw new HttpError(
        409,
        `This email is already registered. If you were charged, please contact support with payment ID ${paymentId}.`,
      );
    }

    const newUser = newMemberFrom(
      { ...reg, email: record.email },
      await generateUniqueId(),
      record.interests,
      {
        commission: record.commission,
        referrerId: record.referrerId,
        referralCode: await newMemberReferralCode(reg.fullName),
      },
    );
    newUser.transactions.push({
      orderId,
      paymentId,
      amountPaid: record.amountCharged,
      noOfInterest: record.interests,
      note: record.note,
    });

    try {
      await newUser.save();
    } catch (err) {
      // Browser and webhook racing to create the same paid account.
      if (/** @type {{ code?: number }} */ (err)?.code === 11000) {
        const winner = await User.findOne({ "basic.email": record.email });
        if (winner?.transactions.some((t) => t.orderId === orderId)) {
          return res.json(loginPayload(winner));
        }
      }
      throw err;
    }

    await saveOrder(orderId, {
      ...record,
      registration: { ...reg, passwordHash: undefined },
      fulfilled: true,
      paymentId,
    });
    await markCheckoutPaid(orderId);
    await markConverted({ email: record.email, mobile: reg.mobile });
    // Refer & earn: send the referring member their reward (never throws).
    await payReferralReward({
      referrerId: record.referrerId,
      friend: newUser,
      amount: record.referralReward,
    });

    notify({
      to: [{ email: record.email }],
      template_id: "welcome_user_2",
      variables: {
        userName: reg.fullName,
        orderId,
        paymentId,
        numInterests: record.interests,
        amount: record.amountCharged,
      },
    });

    res.json(loginPayload(newUser));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error("Register Error:", err);
    return sendHttpError(
      res,
      err,
      "Registration failed after payment. Please contact support with your payment ID.",
    );
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    await dbConnect();

    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    // Partner mode with no partner account for this email: most likely a member
    // who opened partner login by mistake, so fall through to member login.
    const broker = req.body?.isPartner
      ? await Broker.findOne({ email }).select("+password")
      : null;
    if (broker) {
      if (!(await bcrypt.compare(password, broker.password))) {
        return res.status(400).json({ msg: "Invalid partner credentials" });
      }
      if (broker.status === "rejected") {
        return res.status(403).json({
          msg: "Your partner application was not approved. Please contact support for details.",
        });
      }
      if (broker.status === "suspended") {
        return res
          .status(403)
          .json({
            msg: "This partner account is suspended. Please contact support.",
          });
      }
      return res.json(brokerLoginPayload(broker));
    }

    const user = await User.findOne({ "basic.email": email });
    if (!user?.basic?.password)
      return res.status(400).json({ msg: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.basic.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    if (user.isCorrupted) {
      return res.status(403).json({
        msg: "Your profile has violated our policy. Contact admin to review your account.",
      });
    }

    if (user.isHidden) {
      user.isHidden = false;
      await user.save();
    }

    res.json(loginPayload(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
