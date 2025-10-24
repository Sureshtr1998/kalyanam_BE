import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import upload from "../middleware/upload.js";
import otpLimiter from "../middleware/otpLimiter.js";
import cloudinary from "../config/cloudinary.js";
import { auth } from "../middleware/auth.js";
import otpGenerator from "otp-generator";
import transporter from "../config/nodeMailer.js";
import { generateUniqueId } from "../utils/utils.js";
import twilioClient from "../config/twilio.js";
import { arrayFields } from "../utils/constants.js";

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

    const existingMobile = await User.findOne({ mobile });
    if (existingMobile) {
      return res.status(400).json({ msg: "Mobile number already registered" });
    }

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
      id: user._id,
      username: user.fullName,
      email: user.email,
      token,
    });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

// POST /api/fetch-profiles
router.post("/fetch-profiles", auth, async (req, res) => {
  try {
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

    await transporter.sendMail({
      from: `"Seetha Rama Kalyana" <${process.env.EMAIL_USER}>`,
      to: receiver.email,
      subject: "New Interest Received on Seetha Rama Kalyana",
      html: `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; border:1px solid #eaeaea; padding:20px; border-radius:10px;">
      <h2 style="color:#007BFF;">You’ve Received a New Interest 💌</h2>
      <p>Dear ${receiver.fullName || "User"},</p>
      <p><b>${
        sender.fullName
      }</b> has shown interest in your profile on <b>Seetha Rama Kalyana</b>.</p>
      <p>Visit your profile Invitation Status to view their details and decide whether to <b>Accept</b> or <b>Decline</b> the interest.</p>
      <div style="text-align:center; margin-top:20px;">
        <a href="${
          process.env.FRONTEND_URL
        }/invitations" style="background-color:#007BFF; color:#fff; padding:10px 20px; text-decoration:none; border-radius:5px;">View Interest</a>
      </div>
      <p style="margin-top:30px;">Thank you for using <b>Seetha Rama Kalyana</b>.</p>
    </div>
  `,
    });

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
      "-password -email -__v"
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

      return {
        ...user,
        invitationStatus: status,
        mobile: status === "accept" ? user.mobile : undefined,
        alternateMob: status === "accept" ? user.alternateMob : undefined,
      };
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
    if (action === "accept") {
      await transporter.sendMail({
        from: `"Seetha Rama Kalyana" <${process.env.EMAIL_USER}>`,
        to: otherUser.email, // original sender of the interest
        subject: "Your Interest Has Been Accepted 💖",
        html: `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; border:1px solid #eaeaea; padding:20px; border-radius:10px;">
      <h2 style="color:#28a745;">Good News! Your Interest Was Accepted 💖</h2>
      <p>Dear ${otherUser.fullName || "User"},</p>
      <p><b>${
        currentUser.fullName
      }</b> has accepted your interest on <b>Seetha Rama Kalyana</b>.</p>
      <p>You can now view their contact details and continue your conversation.</p>
      <div style="text-align:center; margin-top:20px;">
        <a href="${
          process.env.FRONTEND_URL
        }/login" style="background-color:#28a745; color:#fff; padding:10px 20px; text-decoration:none; border-radius:5px;">View Profile</a>
      </div>
      <p style="margin-top:30px;">We wish you all the best in your journey together!</p>
      <p>– The <b>Seetha Rama Kalyana</b> Team</p>
    </div>
  `,
      });
    }
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

    await transporter.sendMail({
      from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: "Account Deletion Confirmation",
      html: `
    <div style="font-family:Arial,sans-serif;">
      <h3>Account Deletion</h3>
      <p>Hello ${user.fullName || ""},</p>
      <p>Your account has been successfully deleted. We are sorry to see you go!</p>
      <p>If this was a mistake, please contact our support team immediately.</p>
      <p>Thank you for using Seetha Rama Kalyana.</p>
    </div>
  `,
    });

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

      await transporter.sendMail({
        from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
        to: currentUser.email,
        subject: "Account Hidden Successfully",
        html: `
    <div style="font-family:Arial,sans-serif;">
      <h3>Account Hidden</h3>
      <p>Hello ${currentUser.fullName || ""},</p>
      <p>Your profile has been successfully hidden. You will be logged out.</p>
      <p>Your profile will automatically become visible again when you log in next time.</p>
      <p>If you did not request this, please contact our support team.</p>
      <p>Thank you for using Seetha Rama Kalyana.</p>
    </div>
  `,
      });

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

//Password Reset

const otpStore = new Map();
//POST /api/request-reset
router.post("/request-reset", otpLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email)
      return res.status(400).json({ success: false, msg: "Email is required" });

    const user = await User.findOne({ email });
    if (!user)
      return res.status(404).json({ success: false, msg: "User not found" });

    // Generate 6-digit OTP
    const otp = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars: false,
      lowerCaseAlphabets: false,
    });

    otpStore.set(email, { otp, expires: Date.now() + 5 * 60 * 1000 }); // valid for 5 min

    // Send OTP via email
    await transporter.sendMail({
      from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Password Reset OTP from Seetha Rama Kalyana",
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h3>Reset Your Password</h3>
          <p>Your OTP is:</p>
          <h2>${otp}</h2>
          <p>This OTP is valid for <b>5 minutes</b>.</p>
          <p>If you didn't request this, please ignore this email.</p>
        </div>
      `,
    });

    console.log(`OTP sent to ${email}: ${otp}`); // Debug log
    return res.json({
      success: true,
      msg: "OTP sent to your registered email",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

//POST /api/verify-otp

router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;

  const record = otpStore.get(email);
  if (!record)
    return res
      .status(400)
      .json({ success: false, msg: "OTP not found or expired" });

  if (Date.now() > record.expires)
    return res.status(400).json({ success: false, msg: "OTP expired" });

  if (record.otp !== otp)
    return res.status(400).json({ success: false, msg: "Invalid OTP" });

  otpStore.delete(email);
  otpStore.set(email, { verified: true });

  res.json({ success: true, msg: "OTP verified successfully" });
});

//POST /api/reset-password

router.post("/reset-password", async (req, res) => {
  const { email, newPassword } = req.body;

  const record = otpStore.get(email);
  if (!record || !record.verified)
    return res
      .status(400)
      .json({ success: false, msg: "OTP not verified or expired" });

  const hashed = await bcrypt.hash(newPassword, 10);
  await User.findOneAndUpdate({ email }, { password: hashed });

  otpStore.delete(email);
  res.json({ success: true, msg: "Password reset successful" });
});

// Validations

const validateOtpStore = new Map();
//POST /api/send-otp

router.post("/send-otp", async (req, res) => {
  const { email, mobile } = req.body;
  if (!email || !mobile)
    return res
      .status(400)
      .json({ success: false, msg: "Email and mobile are required" });

  const emailOtp = otpGenerator.generate(6, {
    upperCaseAlphabets: false,
    specialChars: false,
  });
  const mobileOtp = otpGenerator.generate(6, {
    upperCaseAlphabets: false,
    specialChars: false,
  });

  validateOtpStore.set(email, {
    emailOtp,
    mobileOtp,
    mobile,
    expires: Date.now() + 5 * 60 * 1000,
  });

  // Send Email OTP
  try {
    await transporter.sendMail({
      from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Email OTP Verification - Seetha Rama Kalyana",
      html: `<p>Your email OTP is <b>${emailOtp}</b> (valid for 5 minutes).</p>`,
    });
  } catch (err) {
    console.error("Email error:", err.message);
    return res
      .status(500)
      .json({ success: false, msg: "Failed to send email OTP" });
  }

  // Send SMS OTP
  try {
    await twilioClient.messages.create({
      body: `Your mobile OTP is ${mobileOtp}. Valid for 5 minutes.`,
      from: process.env.TWILIO_PHONE,
      to: `+91${mobile}`,
    });
  } catch (err) {
    console.error("SMS error:", err.message);
    return res
      .status(500)
      .json({ success: false, msg: "Failed to send SMS OTP" });
  }

  res.json({ success: true, msg: "OTP sent to email and mobile" });
});

//POST /api/verify-otp

router.post("/verify-otp-registration", async (req, res) => {
  const { email, emailOtp, mobileOtp } = req.body;

  const record = validateOtpStore.get(email);
  if (!record)
    return res.status(400).json({ success: false, msg: "OTP not found" });

  if (record.expires < Date.now())
    return res.status(400).json({ success: false, msg: "OTP expired" });

  if (record.emailOtp !== emailOtp)
    return res.status(400).json({ success: false, msg: "Invalid email OTP" });

  if (record.mobileOtp !== mobileOtp)
    return res.status(400).json({ success: false, msg: "Invalid phone OTP" });

  validateOtpStore.delete(email); // OTPs verified → remove record

  // ✅ Here, you can create a new user or mark registration as complete
  res.json({ success: true, msg: "Email and phone verified successfully!" });
});

export default router;
