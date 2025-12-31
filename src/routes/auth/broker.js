// controllers/broker.controller.ts
import bcrypt from "bcryptjs";
import dbConnect from "../../utils/dbConnect.js";
import Broker from "../../models/Broker.js";
import { generateBrokerId, uploadToImageKit } from "../../utils/utils.js";
import { Router } from "express";
import upload from "../../middleware/upload.js";
import { publishQStash } from "../../config/upStash.js";
import sendEmail from "../../config/msg91Email.js";

const router = Router();

router.post("/broker-register", async (req, res) => {
  try {
    await dbConnect();

    const {
      name,
      email,
      phone,
      companyName,
      address,
      note,
      caste,
      password,
      confirmPassword,
      idProofs, // [{ url, fileId }]
      motherTongue,
      // Transactions
      paymentId,
      amountPaid,
    } = req.body;

    if (!name || !email || !phone || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    const existingBroker = await Broker.findOne({
      $or: [{ email }, { phone }],
    });

    if (existingBroker) {
      return res.status(409).json({
        success: false,
        message: "Broker already registered with this email or phone",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const broker = await Broker.create({
      name,
      email,
      phone,
      companyName,
      address,
      note,
      caste,
      password: hashedPassword,
      idProofs: idProofs || [],
      motherTongue,
    });

    await sendEmail({
      to: [{ email: email }],
      template_id: "broker_registration", // MSG91 Template ID
      variables: {
        userName: name,
        paymentId: paymentId,
        amount: amountPaid,
      },
    });

    const delay = name === "Suresh TR" ? "1m" : "5h31m";

    await publishQStash("broker-completion", { email, role: "BROKER" }, delay);
    return res.status(201).json({
      success: true,
      message: "Broker registered successfully",
      data: {
        id: broker._id,
        name: broker.name,
        email: broker.email,
        phone: broker.phone,
      },
    });
  } catch (error) {
    console.error("Broker registration error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while registering broker",
    });
  }
});

router.post("/broker-completion", async (req, res) => {
  try {
    await dbConnect();

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const broker = await Broker.findOne({ email });

    if (!broker) {
      return res.status(404).json({
        success: false,
        message: "Broker not found",
      });
    }

    const referralId = generateBrokerId(broker.name);

    broker.referralId = referralId;
    await broker.save();

    await sendEmail({
      to: [{ email: email }],
      template_id: "broker_confirmation", // MSG91 Template ID
      variables: {
        userName: broker.name,
        referralId: referralId,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Broker profile completed successfully",
      data: {
        email: broker.email,
        referralId: broker.referralId,
      },
    });
  } catch (error) {
    console.error("Broker completion error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to complete broker profile",
    });
  }
});

router.post(
  "/broker-register/upload-idproof",
  upload.array("images", 3),
  async (req, res) => {
    try {
      await dbConnect();

      const files = req.files || [];

      if (!files.length) {
        return res.status(400).json({
          message: "No images uploaded",
        });
      }

      const uploadedMedia = [];

      // @ts-ignore
      for (const file of files) {
        const result = await uploadToImageKit(
          file.buffer,
          file.originalname,
          true
        );

        uploadedMedia.push({
          url: result.url,
          fileId: result.fileId,
        });
      }

      return res.json({ media: uploadedMedia });
    } catch (error) {
      console.error("Broker ID proof upload error:", error);
      return res.status(500).json({
        message: "Failed to upload ID proof",
      });
    }
  }
);

router.get("/validate-referral/:referralId", async (req, res) => {
  try {
    await dbConnect();

    const { referralId } = req.params;

    if (!referralId) {
      return res
        .status(400)
        .json({ valid: false, msg: "Referral ID required" });
    }

    const broker = await Broker.findOne({ referralId: referralId }).select(
      "_id"
    );

    if (!broker) {
      return res.json({ valid: false, msg: "Invalid referral ID" });
    }

    return res.json({ valid: true, msg: "Valid referral ID" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, msg: "Server error" });
  }
});

router.get("/broker-validation", async (req, res) => {
  try {
    const { email, mobile } = req.query;

    if (!email && !mobile) {
      return res.status(400).json({ msg: "Email or Mobile is required" });
    }

    await dbConnect();

    const existingUser = await Broker.findOne({ email: email });
    if (existingUser)
      return res.status(400).json({ msg: "Email already exists" });

    const existingMobile = await Broker.findOne({ phone: mobile });
    if (existingMobile)
      return res.status(400).json({ msg: "Mobile number already registered" });

    return res.json({ success: true, msg: "Valid" });
  } catch (err) {
    console.error("Broker Validation Error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

export default router;
