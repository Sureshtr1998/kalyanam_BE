import jwt from "jsonwebtoken";
import { Router } from "express";
import { generateUniqueId, uploadToImageKit } from "../../utils/utils.js";
import upload from "../../middleware/upload.js";
import bcrypt from "bcryptjs";
import User from "../../models/User.js";
import { expiresIn } from "../../utils/constants.js";
import sendEmail from "../../config/msg91Email.js";

const router = Router();

router.post(
  "/user-register/upload-images",
  upload.array("images", 3),
  async (req, res) => {
    try {
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

      res.json({ media: uploadedMedia });
    } catch (err) {
      console.error("Image upload error:", err);
      res.status(500).json({ msg: "Image upload failed" });
    }
  }
);

router.post("/user-register", async (req, res) => {
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
      gothra,
      images = [],
      //Transaction Details
      orderId,
      amountPaid,
      totalNoOfInterest,
      note,
    } = req.body;

    // Basic validation
    if (!email || !password || !fullName || !mobile) {
      return res.status(400).json({ msg: "Please fill all required fields" });
    }

    const existingUser = await User.findOne({ "basic.email": email });
    if (existingUser)
      return res.status(400).json({ msg: "User already exists" });

    const existingMobile = await User.findOne({ "basic.mobile": mobile });
    if (existingMobile)
      return res.status(400).json({ msg: "Mobile number already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const calculateAge = (dob) => {
      if (!dob) return -1;
      const birthDate = new Date(dob);
      const diff = Date.now() - birthDate.getTime();
      const ageDate = new Date(diff);
      return Math.abs(ageDate.getUTCFullYear() - 1970);
    };

    const emailNormalized = email.trim().toLowerCase();
    const userCount = await User.countDocuments();
    const uniqueId = await generateUniqueId(userCount);

    const newUser = new User({
      basic: {
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
        gothra,
        qualification,
        images,
        uniqueId,
      },
      interests: {
        totalNoOfInterest,
      },
      transactions: [
        {
          orderId,
          dateOfTrans: new Date(),
          amountPaid,
          noOfInterest: totalNoOfInterest,
          note,
        },
      ],
    });

    await newUser.save();

    await sendEmail({
      to: [{ email: emailNormalized }],
      template_id: "welcome_user_2", // MSG91 Template ID
      variables: {
        userName: fullName,
        orderId,
        amount: amountPaid,
      },
    });

    const token = jwt.sign({ id: newUser._id }, process.env.JWT_SECRET, {
      expiresIn: expiresIn,
    });

    const newUserObj = newUser.toObject();
    if (newUserObj.basic) delete newUserObj.basic.password;

    res.json({
      id: newUserObj._id,
      fullName: newUserObj.basic.fullName,
      email: newUserObj.basic.email,
      mobile: newUserObj.basic.mobile,
      token,
    });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    let { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    email = email.trim().toLowerCase();

    const user = await User.findOne({ "basic.email": email });
    if (!user) return res.status(400).json({ msg: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.basic.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

    if (user.isHidden) {
      user.isHidden = false;
      await user.save();
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: expiresIn,
    });

    res.json({
      id: user._id,
      fullName: user.basic.fullName,
      email: user.basic.email,
      token,
      mobile: user.basic.mobile,
    });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
