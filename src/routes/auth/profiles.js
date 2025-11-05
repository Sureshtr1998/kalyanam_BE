import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import upload from "../../middleware/upload.js";
import { arrayFields } from "../../utils/constants.js";
import { uploadToImageKit } from "../../utils/utils.js";

const router = Router();

router.post("/fetch-profiles", auth, async (req, res) => {
  try {
    // @ts-ignore
    const currentUser = req.user;
    if (!currentUser.basic?.gender) {
      return res.status(400).json({ msg: "Current user gender not set" });
    }

    const oppositeGender =
      currentUser.basic.gender.toLowerCase() === "male" ? "female" : "male";

    const { page = 1, limit = 10, filters = {} } = req.body;
    const skip = (page - 1) * limit;

    // Excluded IDs (users already interacted with)
    const excludedIds = [
      ...currentUser.interests.accepted,
      ...currentUser.interests.declined,
      ...currentUser.hideProfiles,
      ...currentUser.interests.sent,
      ...currentUser.interests.received,
    ];

    // --- Build query dynamically ---
    const query = {
      "basic.gender": { $regex: new RegExp(`^${oppositeGender}$`, "i") },
      _id: { $ne: currentUser._id, $nin: excludedIds },
      isHidden: false,
    };

    // Partner filters
    const {
      ageFrom,
      ageTo,
      martialStatus,
      heightFrom,
      heightTo,
      subCaste,
      employedIn,
      qualification,
      country,
    } = filters.partner || {};

    if (ageFrom || ageTo) {
      query["basic.age"] = {};
      if (ageFrom) query["basic.age"].$gte = parseInt(ageFrom);
      if (ageTo) query["basic.age"].$lte = parseInt(ageTo);
    }

    if (heightFrom || heightTo) {
      const heightCondition = {};
      if (heightFrom) heightCondition.$gte = parseFloat(heightFrom);
      if (heightTo) heightCondition.$lte = parseFloat(heightTo);

      query.$or = [
        { "personal.height": heightCondition },
        { "personal.height": { $exists: false } },
        { "personal.height": null },
      ];
    }

    if (martialStatus?.length)
      query["basic.martialStatus"] = { $in: martialStatus };
    if (subCaste?.length) query["basic.subCaste"] = { $in: subCaste };
    if (employedIn?.length) query["personal.employedIn"] = { $in: employedIn };
    if (qualification?.length)
      query["basic.qualification"] = { $in: qualification };
    if (country?.length) query["personal.country"] = { $in: country };

    // Total count
    const totalProfiles = await User.countDocuments(query);

    // Fetch paginated profiles
    const profiles = await User.find(query)
      .skip(skip)
      .limit(limit)
      .select(
        "-basic.password -basic.email -basic.mobile -basic.alternateMob -personal.address"
      );

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

router.get("/my-profile", auth, async (req, res) => {
  try {
    // Fetch profiles excluding current user
    // @ts-ignore
    const currentUser = await User.findById(req.user.id).select(
      "-basic.password"
    );

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json({ profile: currentUser });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

router.post("/my-profile", auth, async (req, res) => {
  try {
    // @ts-ignore
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: "User not found" });

    const { basic = {}, partner = {} } = req.body;

    // Process partner array fields
    for (const [key, value] of Object.entries(partner)) {
      if (arrayFields.includes(key)) {
        partner[key] = Array.isArray(value)
          ? value
          : typeof value === "string"
          ? value.split(",").map((v) => v.trim())
          : [];
      }
    }

    // ✅ Merge existing images with new ones if provided
    const finalImages = basic.images?.length ? basic.images : user.basic.images;

    const updateFields = {
      ...req.body,
      basic: {
        // @ts-ignore
        ...user.basic.toObject(),
        ...basic,
        images: finalImages,
      },
      partner,
      hasCompleteProfile: true,
    };

    Object.assign(user, updateFields);
    await user.save();

    res.json({ profile: user });
  } catch (err) {
    console.error("Profile Update Error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

router.post(
  "/my-profile/upload-images",
  auth,
  upload.array("images"),
  async (req, res) => {
    try {
      const uploadedFiles = req.files || [];
      const uploadedMedia = [];

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
