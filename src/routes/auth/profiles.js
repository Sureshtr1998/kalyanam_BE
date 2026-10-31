import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import Broker from "../../models/Broker.js";
import upload, { requireImageContent } from "../../middleware/upload.js";
import { uploadLimiter } from "../../middleware/otpLimiter.js";
import { uploadToImageKit } from "../../utils/utils.js";
import dbConnect from "../../utils/dbConnect.js";
import { deleteRemovedImages } from "../../utils/images.js";
import upStash from "../../config/upStash.js";
import { normalizeEmail } from "../../utils/constants.js";
import {
  acceptsViewerQuery,
  escapeRegex,
  publicProjection,
  toList,
} from "../../utils/matching.js";

const router = Router();

// Fields a member may change from the profile page. Everything else
// (name, dob, interests, transactions, verification flags…) is server-owned.
export const EDITABLE = {
  basic: [
    "gothra",
    "alternateMob",
    "motherTongue",
    "martialStatus",
    "profileCreatedBy",
    "qualification",
    "subCaste",
    "note",
  ],
  personal: [
    "height",
    "workCity",
    "country",
    "residingStatus",
    "weight",
    "diet",
    "address",
    "salary",
    "employedIn",
    "rashi",
    "nakshatra",
    "note",
  ],
  family: [
    "familyStatus",
    "elderBro",
    "youngerBro",
    "elderSis",
    "youngerSis",
    "elderBroMar",
    "youngerBroMar",
    "elderSisMar",
    "youngerSisMar",
    "fatherName",
    "fatherStatus",
    "fatherOccup",
    "motherName",
    "motherStatus",
    "motherOccup",
    "note",
  ],
  partner: [
    "ageFrom",
    "ageTo",
    "martialStatus",
    "heightFrom",
    "heightTo",
    "caste",
    "subCaste",
    "motherTongue",
    "employedIn",
    "note",
    "qualification",
    "country",
  ],
};

export const MANDATORY = {
  basic: ["qualification", "martialStatus", "motherTongue", "caste"],
  personal: ["height", "country", "employedIn", "residingStatus", "diet"],
  family: ["motherName", "fatherName"],
  partner: ["ageFrom", "ageTo", "caste", "employedIn"],
};

export const pick = (source, keys) => {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
};

const isFilled = (v) => (Array.isArray(v) ? v.length > 0 : !!v);

export const isComplete = (user) =>
  Object.entries(MANDATORY).every(([section, keys]) =>
    keys.every((k) => isFilled(user[section]?.[k]))
  ) && (user.basic?.images?.length ?? 0) > 0;

router.get("/hidden-profiles", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const currentUser = await User.findById(req.user.id).select(
      "-basic.password -transactions"
    );

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    const orderedIds = [...(currentUser.hideProfiles || [])];

    const users = await User.find(
      { _id: { $in: orderedIds } },
      "-basic.password -hideProfiles -basic.email -basic.alternateMob -basic.mobile -transactions -astrology -shortlisted -profileViews -__v"
    ).lean();

    // Deleted accounts leave ids behind; skip them.
    const sortedUsers = orderedIds
      .map((id) => users.find((u) => u._id.toString() === id.toString()))
      .filter(Boolean);

    res.status(200).json({
      success: true,
      count: sortedUsers.length,
      activities: sortedUsers,
      currentUser: currentUser,
    });
  } catch (err) {
    console.error("Error fetching hidden profiles:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/unhide-profile", auth, async (req, res) => {
  try {
    await dbConnect();

    const { userId } = req.body || {};
    // @ts-ignore
    const currentUserId = req.user.id;

    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    currentUser.hideProfiles = currentUser.hideProfiles.filter(
      (id) => id.toString() !== String(userId)
    );
    await currentUser.save();

    return res.status(200).json({
      success: true,
      msg: "This profile will be visible in your matches again",
      hideProfiles: currentUser.hideProfiles,
    });
  } catch (err) {
    console.error("Error unhidding profile:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

/**
 * Matches for the current member. A profile is returned only when
 *  - it fits the member's filters (sent from the UI, defaulting to their preferences), and
 *  - the member fits THAT profile's partner preferences (two-way matching), and
 *  - neither side has blocked the other.
 */
router.post("/fetch-profiles", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const currentUser = req.user;
    if (!currentUser.basic?.gender) {
      return res.status(400).json({ msg: "Current user gender not set" });
    }

    const oppositeGender =
      currentUser.basic.gender.toLowerCase() === "male" ? "female" : "male";

    const { filters = {} } = req.body || {};
    const page = Math.max(1, parseInt(req.body?.page) || 1);
    const limit = Math.min(48, Math.max(1, parseInt(req.body?.limit) || 12));
    const skip = (page - 1) * limit;

    // Already interacted with, or blocked by me
    const excludedIds = [
      ...currentUser.interests.accepted,
      ...currentUser.interests.declined,
      ...currentUser.hideProfiles,
      ...currentUser.interests.sent,
      ...currentUser.interests.viewed,
      ...currentUser.interests.received,
    ];

    /** @type {Record<string, any>[]} */
    const and = [...acceptsViewerQuery(currentUser)];
    const query = {
      "basic.gender": { $regex: new RegExp(`^${oppositeGender}$`, "i") },
      _id: { $ne: currentUser._id, $nin: excludedIds },
      isHidden: false,
      isCorrupted: { $ne: true },
      hasCompleteProfile: true,
      hideProfiles: { $ne: currentUser._id },
    };

    const {
      ageFrom,
      ageTo,
      martialStatus,
      heightFrom,
      heightTo,
      caste,
      subCaste,
      employedIn,
      qualification,
      motherTongue,
      country,
    } = filters.partner || {};

    // Case-insensitive "one of" (older profiles stored e.g. "brahmin").
    const oneOf = (field, values) => {
      const list = toList(values);
      if (list.length) {
        query[field] = {
          $in: list.map((v) => new RegExp(`^${escapeRegex(v)}$`, "i")),
        };
      }
    };

    if (ageFrom || ageTo) {
      const today = new Date();
      const dobQuery = {};
      if (ageFrom) {
        dobQuery.$lte = new Date(
          Date.UTC(today.getUTCFullYear() - parseInt(ageFrom), today.getUTCMonth(), today.getUTCDate())
        );
      }
      if (ageTo) {
        dobQuery.$gte = new Date(
          Date.UTC(today.getUTCFullYear() - parseInt(ageTo) - 1, today.getUTCMonth(), today.getUTCDate() + 1)
        );
      }
      query["basic.dob"] = dobQuery;
    }

    if (heightFrom || heightTo) {
      const heightCondition = {};
      if (heightFrom) heightCondition.$gte = String(heightFrom);
      if (heightTo) heightCondition.$lte = String(heightTo);
      and.push({
        $or: [
          { "personal.height": heightCondition },
          { "personal.height": { $exists: false } },
          { "personal.height": null },
        ],
      });
    }

    oneOf("basic.martialStatus", martialStatus);
    oneOf("basic.caste", caste);
    oneOf("basic.subCaste", subCaste);
    oneOf("basic.motherTongue", motherTongue);
    oneOf("personal.employedIn", employedIn);
    oneOf("basic.qualification", qualification);
    oneOf("personal.country", country);
    oneOf("personal.diet", filters.diet);

    if (filters.verifiedOnly) query.isVerified = true;
    if (filters.activeWithinDays) {
      const days = Math.min(90, Math.max(1, parseInt(filters.activeWithinDays) || 30));
      query.lastActiveAt = { $gte: new Date(Date.now() - days * 86400000) };
    }

    if (and.length) query.$and = and;

    /** @type {Record<string, 1 | -1>} */
    const sort =
      filters.sort === "active"
        ? { lastActiveAt: -1, createdAt: -1 }
        : filters.sort === "newest"
        ? { createdAt: -1 }
        : { isVerified: -1, createdAt: -1 };

    const totalProfiles = await User.countDocuments(query);
    const profiles = await User.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(publicProjection);

    return res.json({
      profiles,
      totalProfiles,
      totalPages: Math.ceil(totalProfiles / limit),
      page,
      limit,
    });
  } catch (err) {
    console.error("Fetch Profiles Error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

// The partner whose referral ID the member registered with, so the profile
// page can show who referred them. Discount codes have no partner behind them.
const withReferrer = async (profile) => {
  const code = profile.basic?.referralId;
  if (!code) return profile;
  const broker = await Broker.findOne({ referralId: code }).select("name companyName referralId -_id").lean();
  return { ...profile, referredBy: broker ?? null };
};

router.get("/my-profile", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const currentUser = await User.findById(req.user.id)
      .select("-basic.password")
      .lean();

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json({ profile: await withReferrer(currentUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

router.post("/my-profile", auth, async (req, res) => {
  try {
    await dbConnect();
    // @ts-ignore
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: "User not found" });

    const body = req.body || {};
    const basic = pick(body.basic, EDITABLE.basic);

    if (Array.isArray(body.basic?.images)) {
      const images = body.basic.images
        .filter((i) => i && typeof i.url === "string" && typeof i.fileId === "string")
        .slice(0, 3)
        .map((i) => ({ url: i.url, fileId: i.fileId }));
      if (images.length) basic.images = images;
    }

    // Email / WhatsApp number become editable only through OTP verification.
    // Admins can verify themselves (and others) without the OTP step.
    if (!user.isVerified && user.isAdmin) {
      user.isVerified = true;
    } else if (!user.isVerified) {
      const email = normalizeEmail(body.basic?.email);
      const mobile = String(body.basic?.mobile || "");
      const verified = await upStash.get(`contact_verified:${user._id}`);
      if (!verified || verified.email !== email || verified.mobile !== mobile) {
        return res.status(400).json({
          msg: "Please verify your email and WhatsApp number to save your profile.",
          needsVerification: true,
        });
      }
      basic.email = email;
      basic.mobile = mobile;
      user.isVerified = true;
      await upStash.del(`contact_verified:${user._id}`);
    }

    const imagesBefore = user.basic.images.map((i) => ({ fileId: i.fileId }));
    const current = user.toObject();
    user.set("basic", { ...current.basic, ...basic });
    user.set("personal", {
      ...(current.personal || {}),
      ...pick(body.personal, EDITABLE.personal),
    });
    user.set("family", {
      ...(current.family || {}),
      ...pick(body.family, EDITABLE.family),
    });
    user.set("partner", {
      ...(current.partner || {}),
      ...pick(body.partner, EDITABLE.partner),
    });
    user.hasCompleteProfile = isComplete(user);

    await user.save();
    void deleteRemovedImages(user._id, imagesBefore, user.basic.images);

    const profile = user.toObject();
    delete profile.basic.password;
    res.json({ profile: await withReferrer(profile) });
  } catch (err) {
    console.error("Profile Update Error:", err);
    if (err?.code === 11000) {
      return res
        .status(400)
        .json({ msg: "That email or WhatsApp number is already registered" });
    }
    res.status(500).json({ msg: "Server error" });
  }
});

router.post(
  "/my-profile/upload-images",
  uploadLimiter,
  auth,
  upload.array("images", 3),
  requireImageContent,
  async (req, res) => {
    try {
      await dbConnect();

      const uploadedFiles = req.files || [];
      const uploadedMedia = [];

      // @ts-ignore
      for (const file of uploadedFiles) {
        const result = await uploadToImageKit(file.buffer, file.originalname);
        uploadedMedia.push({ url: result.url, fileId: result.fileId });
      }

      res.json({ media: uploadedMedia });
    } catch (err) {
      console.error("Image Upload Error:", err);
      res.status(500).json({ msg: "Image upload failed" });
    }
  }
);

export default router;
