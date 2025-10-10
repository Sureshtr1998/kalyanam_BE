import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import upload from "../middleware/upload.js";
import cloudinary from "../config/cloudinary.js";

const router = Router();

const streamUpload = (fileBuffer) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "image" },
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
      maritalStatus,
      profileCreatedBy,
      pincode,
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

    const newUser = new User({
      email,
      password: hashedPassword,
      fullName,
      mobile,
      alternateMob,
      dob,
      gender,
      motherTongue,
      maritalStatus,
      profileCreatedBy,
      pincode,
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
    console.error(error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
});

// POST /api/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
