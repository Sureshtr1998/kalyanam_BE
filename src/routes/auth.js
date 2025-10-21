import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import upload from "../middleware/upload.js";
import cloudinary from "../config/cloudinary.js";
import { auth } from "../middleware/auth.js";

const router = Router();

const streamUpload = (fileBuffer) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "image", folder: "user_profiles" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(fileBuffer);
  });
};

// POST /api/user-register
router.post("/user-register", upload.array("images", 3), async (req, res) => {
  try {
    const {
      email,
      password,
      fullName,
      mobile,
      alternateMob,
      dob,
      gender,
      motherTongue,
      martialStatus,
      profileCreatedBy,
      subCaste,
      qualification,
      gotra,
    } = req.body;

    // Basic validation
    if (!email || !password || !fullName || !mobile) {
      return res.status(400).json({ msg: "Please fill all required fields" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser)
      return res.status(400).json({ msg: "User already exists" });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Upload images to Cloudinary
    const files = req.files;
    let imageUrls = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const result = await streamUpload(file.buffer);
        imageUrls.push(result.secure_url);
      }
    }
    const emailNormalized = email.trim().toLowerCase();

    const calculateAge = (dob) => {
      if (!dob) return -1;
      const birthDate = new Date(dob);
      const diff = Date.now() - birthDate.getTime();
      const ageDate = new Date(diff);
      return Math.abs(ageDate.getUTCFullYear() - 1970);
    };
    const uniqueId = await generateUniqueId();
    const newUser = new User({
      email: emailNormalized,
      password: hashedPassword,
      fullName,
      mobile,
      alternateMob,
      dob,
      age: calculateAge(dob),
      gender,
      motherTongue,
      martialStatus,
      profileCreatedBy,
      subCaste,
      gotra,
      qualification,
      images: imageUrls,
      username: email,
      uniqueId,
    });

    await newUser.save();

    // JWT token
    const token = jwt.sign({ id: newUser._id }, process.env.JWT_SECRET, {
      expiresIn: "12h",
    });

    const { password: _, ...userData } = newUser.toObject(); // remove password
    res.json({
      token,
      user: {
        id: userData._id,
        username: userData.fullName,
        email: userData.email,
        isHidden: userData.isHidden,
      },
    });
  } catch (error) {
    res.status(500).json({ msg: "Server error", error: error.message });
  }
});

// POST /api/login
router.post("/login", async (req, res) => {
  try {
    let { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    email = email.trim().toLowerCase();

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    if (user.isHidden) {
      user.isHidden = false;
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "12h",
    });

    res.json({
      token,
      user: {
        id: user._id,
        username: user.fullName,
        email: user.email,
        isHidden: user.isHidden,
      },
    });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

// GET /api/fetch-profiles
router.get("/fetch-profiles", auth, async (req, res) => {
  try {
    const currentUser = req.user;

    if (!currentUser.gender) {
      return res.status(400).json({ msg: "Current user gender not set" });
    }

    // Determine opposite gender
    const oppositeGender =
      currentUser.gender.toLowerCase() === "male" ? "female" : "male";

    // Fetch profiles excluding current user
    const excludedIds = [
      ...currentUser.accepted,
      ...currentUser.declined,
      ...currentUser.hideProfiles,
      ...currentUser.sent,
      ...currentUser.received,
    ];

    const profiles = await User.find({
      gender: { $regex: new RegExp(`^${oppositeGender}$`, "i") },
      _id: { $ne: currentUser._id, $nin: excludedIds },
      isHidden: false, // skip users who have hidden their profile
    }).select("-password -email -username -alternateMob -mobile");

    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

// GET /api/my-profile
router.get("/my-profile", auth, async (req, res) => {
  try {
    // Fetch profiles excluding current user
    const currentUser = await User.findById(req.user.id);

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json({ profile: currentUser });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

// POST /api/my-profile

router.post("/my-profile", auth, upload.array("images"), async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ msg: "User not found" });

    // Existing Cloudinary URLs from frontend
    const existingUrls = req.body.imageUrls
      ? Array.isArray(req.body.imageUrls)
        ? req.body.imageUrls
        : [req.body.imageUrls]
      : [];

    const uploadedFiles = req.files;

    // Upload files to Cloudinary
    const uploadedUrls = [];
    for (const file of uploadedFiles) {
      const result = await streamUpload(file.buffer);
      uploadedUrls.push(result.secure_url);
    }

    const finalImageUrls = [...existingUrls, ...uploadedUrls];

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
    res.status(500).json({ msg: "Server error" });
  }
});

//POST /api/send-interest
router.post("/send-interest", auth, async (req, res) => {
  try {
    const sender = await User.findById(req.user.id);
    const { receiverId } = req.body;

    const receiver = await User.findById(receiverId);

    if (!sender || !receiver) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (req.user.id === receiverId) {
      return res.status(400).json({ msg: "Cannot send interest to yourself" });
    }

    if (sender.sent.includes(receiver._id)) {
      return res.status(400).json({ msg: "Interest already sent" });
    }

    // Add interest
    sender.sent.push(receiver._id);
    receiver.received.push(sender._id);

    // Save both users
    await sender.save();
    await receiver.save();

    res.json({ msg: "Interest sent successfully" });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

//GET /api/fetch-invitation-status

router.get("/fetch-invitation-status", auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Combine all IDs
    const allIds = [
      ...(currentUser.sent || []),
      ...(currentUser.received || []),
      ...(currentUser.accepted || []),
      ...(currentUser.declined || []),
    ];

    // Remove duplicates
    const uniqueIds = [...new Set(allIds.map((id) => id.toString()))];

    // Fetch all users at once
    const users = await User.find(
      { _id: { $in: uniqueIds } },
      "-password -email -mobile -alternateMob -__v"
    ).lean();

    // Map each user to correct invitationStatus based on priority
    const combinedList = users.map((user) => {
      let status = "received"; // default

      if (currentUser.accepted?.includes(user._id.toString())) {
        status = "accept";
      } else if (currentUser.declined?.includes(user._id.toString())) {
        status = "decline";
      } else if (currentUser.sent?.includes(user._id.toString())) {
        status = "sent";
      } else if (currentUser.received?.includes(user._id.toString())) {
        status = "received";
      }

      return { ...user, invitationStatus: status };
    });

    res.status(200).json({
      success: true,
      count: combinedList.length,
      invitations: combinedList,
    });
  } catch (err) {
    console.error("Error fetching invitation status:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

//POST /api/interest-action

router.post("/interest-action", auth, async (req, res) => {
  try {
    const { userId, action } = req.body;
    const currentUserId = req.user.id;

    if (!userId || !["accept", "decline"].includes(action)) {
      return res.status(400).json({ msg: "Invalid request data" });
    }

    const currentUser = await User.findById(currentUserId);
    const otherUser = await User.findById(userId);

    console.log(currentUserId, userId, "userId");
    if (!currentUser || !otherUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (action === "accept") {
      currentUser.accepted = [
        ...(currentUser.accepted || []),
        userId.toString(),
      ];
      otherUser.accepted = [
        ...(otherUser.accepted || []),
        currentUserId.toString(),
      ];
    } else if (action === "decline") {
      currentUser.declined = [
        ...(currentUser.declined || []),
        userId.toString(),
      ];
      otherUser.declined = [
        ...(otherUser.declined || []),
        currentUserId.toString(),
      ];
    }

    await currentUser.save();
    await otherUser.save();

    return res.json({
      msg: `Interest ${
        action === "accept" ? "accepted" : "declined"
      } successfully`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: "Server error" });
  }
});

//DELETE /api/delete-account

router.delete("/delete-account", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.images && user.images.length > 0) {
      for (const imageUrl of user.images) {
        try {
          const parts = imageUrl.split("/");
          const filename = parts[parts.length - 1];
          const publicId = filename.split(".")[0];

          await cloudinary.uploader.destroy(publicId);
        } catch (err) {
          console.error("Error deleting Cloudinary image:", err.message);
        }
      }
    }

    await User.findByIdAndDelete(userId);

    res.status(200).json({
      success: true,
      msg: "Account and images deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting account:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

//POST /api/hide-profile

router.post("/hide-profile", auth, async (req, res) => {
  try {
    const { userId } = req.body || {};
    const currentUserId = req.user.id;

    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (!userId) {
      currentUser.isHidden = true;
      await currentUser.save();

      return res.status(200).json({
        success: true,
        msg: "Your profile is now hidden",
      });
    }

    if (!currentUser.hideProfiles.includes(userId)) {
      currentUser.hideProfiles.push(userId);
      await currentUser.save();
    }

    return res.status(200).json({
      success: true,
      msg: "User profile hidden successfully",
      hideProfiles: currentUser.hideProfiles,
    });
  } catch (err) {
    console.error("Error hiding profile:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

//GET /api/user-account

router.get("/user-account", auth, async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    res.status(200).json({
      success: true,
      isHidden: currentUser.isHidden,
    });
  } catch (err) {
    console.error("Error fetching account details:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
