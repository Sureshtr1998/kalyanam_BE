import jwt from "jsonwebtoken";
import { Router } from "express";
import { generateUniqueId, streamUpload } from "../../utils/utils.js";
import upload from "../../middleware/upload.js";
import bcrypt from "bcryptjs";
import User from "../../models/User.js";

const router = Router();

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

    const existingMobile = await User.findOne({ mobile });
    if (existingMobile) {
      return res.status(400).json({ msg: "Mobile number already registered" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Upload images to Cloudinary
    const files = req.files;
    const fileArray = Array.isArray(files) ? files : [];
    let imageUrls = [];
    if (fileArray.length > 0) {
      for (const file of fileArray) {
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
    const userCount = await User.countDocuments();
    const uniqueId = await generateUniqueId(userCount);
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
      id: userData._id,
      username: userData.fullName,
      email: userData.email,
      token,
    });
  } catch (error) {
    res.status(500).json({ msg: "Server error", error: error.message });
  }
});

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
      id: user._id,
      username: user.fullName,
      email: user.email,
      token,
    });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
