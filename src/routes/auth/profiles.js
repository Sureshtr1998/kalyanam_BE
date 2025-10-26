import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import upload from "../../middleware/upload.js";
import { streamUpload } from "../../utils/utils.js";
import { arrayFields } from "../../utils/constants.js";

const router = Router();

router.post("/fetch-profiles", auth, async (req, res) => {
  try {
    // @ts-ignore
    const currentUser = req.user;
    if (!currentUser.gender) {
      return res.status(400).json({ msg: "Current user gender not set" });
    }

    const oppositeGender =
      currentUser.gender.toLowerCase() === "male" ? "female" : "male";

    const { page = 1, limit = 10, filters = {} } = req.body;

    const skip = (page - 1) * limit;

    const excludedIds = [
      ...currentUser.accepted,
      ...currentUser.declined,
      ...currentUser.hideProfiles,
      ...currentUser.sent,
      ...currentUser.received,
    ];

    // --- Build MongoDB query dynamically ---
    const query = {
      gender: { $regex: new RegExp(`^${oppositeGender}$`, "i") },
      _id: { $ne: currentUser._id, $nin: excludedIds },
      isHidden: false,
    };

    // 🎯 Apply filters only if user selected something
    const {
      ageFrom,
      ageTo,
      pMartialStatus,
      heightFrom,
      heightTo,
      pSubCaste,
      pEmployedIn,
      pQualification,
      pCountry,
    } = filters;

    if (ageFrom || ageTo) {
      query.age = {};
      if (ageFrom) query.age.$gte = parseInt(ageFrom);
      if (ageTo) query.age.$lte = parseInt(ageTo);
    }
    if (heightFrom || heightTo) {
      const heightCondition = {};
      if (heightFrom) heightCondition.$gte = parseFloat(heightFrom);
      if (heightTo) heightCondition.$lte = parseFloat(heightTo);

      query.$or = [
        { height: heightCondition },
        { height: { $exists: false } }, // no height field
        { height: null }, // explicitly null
      ];
    }
    if (pMartialStatus?.length) query.martialStatus = { $in: pMartialStatus };

    if (pSubCaste?.length) query.subCaste = { $in: pSubCaste };

    if (pEmployedIn?.length) query.employedIn = { $in: pEmployedIn };

    if (pQualification?.length) query.qualification = { $in: pQualification };

    if (pCountry?.length) query.country = { $in: pCountry };

    const totalProfiles = await User.countDocuments(query);

    const profiles = await User.find(query)
      .skip(skip)
      .limit(limit)
      .select("-password -email -username -alternateMob -mobile");

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
    const currentUser = await User.findById(req.user.id);

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json({ profile: currentUser });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

router.post("/my-profile", auth, upload.array("images"), async (req, res) => {
  try {
    // @ts-ignore
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: "User not found" });

    // Existing Cloudinary URLs from frontend
    const existingUrls = req.body.imageUrls
      ? Array.isArray(req.body.imageUrls)
        ? req.body.imageUrls
        : [req.body.imageUrls]
      : [];

    const uploadedFiles = req.files;
    const fileArray = Array.isArray(uploadedFiles) ? uploadedFiles : [];

    // Upload files to Cloudinary
    const uploadedUrls = [];
    for (const file of fileArray) {
      const result = await streamUpload(file.buffer);
      uploadedUrls.push(result.secure_url);
    }

    const finalImageUrls = [...existingUrls, ...uploadedUrls];

    for (const [key, value] of Object.entries(req.body)) {
      if (arrayFields.includes(key)) {
        if (!value) {
          req.body[key] = [];
        } else {
          req.body[key] = value.split(",");
        }
      }
    }
    // Update other userData fields
    const updateFields = {
      ...req.body,
      images: finalImageUrls,
      hasCompleteProfile: true,
    };
    delete updateFields.imageUrls;

    Object.assign(user, updateFields);
    await user.save();

    res.json({ profile: user });
  } catch (err) {
    console.log(err, "ERR");
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
