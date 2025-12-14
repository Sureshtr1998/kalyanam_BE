import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import upload from "../../middleware/upload.js";
import { uploadToImageKit } from "../../utils/utils.js";
import dbConnect from "../../utils/dbConnect.js";

const router = Router();

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

    // Fetch all users at once
    const users = await User.find(
      { _id: { $in: orderedIds } },
      "-basic.password -hideProfiles -basic.email -basic.alternateMob -basic.mobile -transactions -__v"
    ).lean();

    const sortedUsers = orderedIds?.map((id) =>
      users.find((u) => u._id.toString() === id.toString())
    );

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

    if (currentUser.hideProfiles.includes(userId)) {
      currentUser.hideProfiles = currentUser.hideProfiles.filter(
        (id) => id.toString() !== userId.toString()
      );
      await currentUser.save();
    }

    return res.status(200).json({
      success: true,
      msg: "User profile will be visible in Home page",
      hideProfiles: currentUser.hideProfiles,
    });
  } catch (err) {
    console.error("Error unhidding profile:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

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

    const { page = 1, limit = 10, filters = {} } = req.body;
    const skip = (page - 1) * limit;

    // Excluded IDs (users already interacted with)
    const excludedIds = [
      ...currentUser.interests.accepted,
      ...currentUser.interests.declined,
      ...currentUser.hideProfiles,
      ...currentUser.interests.sent,
      ...currentUser.interests.viewed,
      ...currentUser.interests.received,
    ];

    // --- Build query dynamically ---
    const query = {
      "basic.gender": { $regex: new RegExp(`^${oppositeGender}$`, "i") },
      _id: { $ne: currentUser._id, $nin: excludedIds },
      isHidden: false,
      hideProfiles: { $ne: currentUser._id },
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
      motherTongue,
      country,
    } = filters.partner || {};

    if (ageFrom || ageTo) {
      const today = new Date();
      const dobQuery = {};

      if (ageFrom) {
        const maxDOB = new Date(
          today.getFullYear() - parseInt(ageFrom),
          today.getMonth(),
          today.getDate()
        );
        dobQuery.$lte = maxDOB.toISOString();
      }

      if (ageTo) {
        const minDOB = new Date(
          today.getFullYear() - parseInt(ageTo) - 1,
          today.getMonth(),
          today.getDate() + 1
        );
        dobQuery.$gte = minDOB.toISOString();
      }

      query["basic.dob"] = dobQuery;
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
    if (motherTongue?.length)
      query["basic.motherTongue"] = { $in: motherTongue };
    if (employedIn?.length) query["personal.employedIn"] = { $in: employedIn };
    if (qualification?.length)
      query["basic.qualification"] = { $in: qualification };
    if (country?.length) query["personal.country"] = { $in: country };

    // Total count
    const totalProfiles = await User.countDocuments(query);

    // Fetch paginated profiles
    const profiles = await User.find(query)
      .sort({ isVerified: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        "-createdAt -basic.password -basic.email -basic.mobile -basic.alternateMob -personal.address -hideProfiles -interests -transactions -updatedAt"
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
    await dbConnect();

    // @ts-ignore
    const currentUser = await User.findById(req.user.id)
      .select("-basic.password")
      .lean();

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json({ profile: currentUser });
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

    const { basic = {}, partner = {} } = req.body;

    // ✅ Merge existing images with new ones if provided
    const finalImages = basic.images?.length ? basic.images : user.basic.images;
    const protectedFields = ["fullName", "dob", "uniqueId"];
    protectedFields.forEach((field) => delete basic[field]);
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
      isVerified: true,
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
