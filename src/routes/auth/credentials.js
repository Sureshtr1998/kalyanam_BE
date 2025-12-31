import jwt from "jsonwebtoken";
import { Router } from "express";
import { generateUniqueId, uploadToImageKit } from "../../utils/utils.js";
import upload from "../../middleware/upload.js";
import bcrypt from "bcryptjs";
import User from "../../models/User.js";
import { expiresIn, PENDING_PAYMENT } from "../../utils/constants.js";
import sendEmail from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";
import upStash from "../../config/upStash.js";
import Broker from "../../models/Broker.js";

const router = Router();

router.get("/user-validation", async (req, res) => {
  try {
    const { email, mobile } = req.query;

    if (!email && !mobile) {
      return res.status(400).json({ msg: "Email or Mobile is required" });
    }

    await dbConnect();

    const existingUser = await User.findOne({ "basic.email": email });
    if (existingUser)
      return res.status(400).json({ msg: "Email already exists" });

    const existingMobile = await User.findOne({ "basic.mobile": mobile });
    if (existingMobile)
      return res.status(400).json({ msg: "Mobile number already registered" });

    return res.json({ success: true, msg: "Valid" });
  } catch (err) {
    console.error("User Validation Error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

router.post(
  "/user-register/upload-images",
  upload.array("images", 3),
  async (req, res) => {
    try {
      await dbConnect();
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
    await dbConnect();
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
      caste,
      qualification,
      gothra,
      images = [],
      referralId,
      //Transaction Details
      orderId,
      paymentId,
      amountPaid,
      totalNoOfInterest,
      note,
    } = req.body;

    // Basic validation
    if (!email || !password || !fullName || !mobile) {
      return res.status(400).json({ msg: "Please fill all required fields" });
    }

    const existingEmail = await User.findOne({
      "basic.email": email,
    });

    if (existingEmail) {
      return res.status(400).json({ msg: "Email already registered" });
    }

    const existingMobile = await User.findOne({
      "basic.mobile": mobile,
    });

    if (existingMobile) {
      return res.status(400).json({ msg: "Mobile number already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const emailNormalized = email.trim().toLowerCase();
    const uniqueId = await generateUniqueId();

    const newUser = new User({
      basic: {
        email: emailNormalized,
        password: hashedPassword,
        fullName,
        mobile,
        alternateMob,
        dob,
        gender,
        motherTongue,
        martialStatus,
        profileCreatedBy,
        subCaste,
        caste,
        gothra,
        qualification,
        images,
        uniqueId,
        referralId,
      },
      interests: {
        totalNoOfInterest,
      },
      partner: {
        caste: [caste],
        motherTongue: [motherTongue],
      },
      transactions: [
        {
          orderId,
          paymentId,
          amountPaid,
          noOfInterest: totalNoOfInterest,
          note,
        },
      ],
    });

    await newUser.save();
    await upStash.del(`${PENDING_PAYMENT}${emailNormalized}`);

    await sendEmail({
      to: [{ email: emailNormalized }],
      template_id: "welcome_user_2", // MSG91 Template ID
      variables: {
        userName: fullName,
        orderId,
        paymentId,
        numInterests: totalNoOfInterest,
        amount: amountPaid,
      },
    });

    const token = jwt.sign(
      { id: newUser._id, role: "USER" },
      process.env.JWT_SECRET,
      {
        expiresIn: expiresIn,
      }
    );

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
    await dbConnect();

    let { email, password, isPartner } = req.body;

    if (!email || !password) {
      return res.status(400).json({ msg: "Email and password are required" });
    }

    email = email.trim().toLowerCase();

    let account;
    let accountType;

    if (isPartner) {
      account = await Broker.findOne({ email }).select("+password");
      accountType = "BROKER";
    } else {
      account = await User.findOne({ "basic.email": email }).select(
        "+basic.password"
      );
      accountType = "USER";
    }

    if (!account) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    const hashedPassword = isPartner
      ? // @ts-ignore
        account.password
      : // @ts-ignore
        account.basic.password;

    const isMatch = await bcrypt.compare(password, hashedPassword);
    if (!isMatch) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    // @ts-ignore
    if (!isPartner && account.isHidden) {
      // @ts-ignore
      account.isHidden = false;
      await account.save();
    }

    const token = jwt.sign(
      {
        id: account._id,
        role: accountType,
      },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    if (isPartner) {
      // @ts-ignore
      if (!account?.referralId) {
        return res.status(403).json({
          msg: "Your profile is currently under review. You will receive an email once it has been verified.",
        });
      }
      return res.json({
        id: account._id,
        // @ts-ignore
        name: account.name,
        // @ts-ignore
        email: account.email,
        // @ts-ignore
        referralId: account.referralId,
        role: "BROKER",
        token,
      });
    }

    return res.json({
      id: account._id,
      // @ts-ignore
      fullName: account.basic.fullName,
      // @ts-ignore
      email: account.basic.email,
      // @ts-ignore
      mobile: account.basic.mobile,
      role: "USER",
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
