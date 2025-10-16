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
    });

    await newUser.save();

    // JWT token
    const token = jwt.sign({ id: newUser._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    const { password: _, ...userData } = newUser.toObject(); // remove password
    res.json({ token, user: userData });
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

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
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
      currentUser.gender.toLowerCase() === "male" ? "male" : "male";
    //   currentUser.gender.toLowerCase() === "male" ? "female" : "male";

    // Fetch profiles excluding current user
    const profiles = await User.find({
      gender: { $regex: new RegExp(`^${oppositeGender}$`, "i") },
      _id: { $ne: currentUser._id },
    }).select("-password -email -username -alternateMob");

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
    const updateFields = { ...req.body, images: finalImageUrls };
    delete updateFields.imageUrls;

    Object.assign(user, updateFields);
    await user.save();

    res.json({ profile: user });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
