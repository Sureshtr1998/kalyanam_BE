import { Router } from "express";
import Broker from "../../models/Broker.js";
import User from "../../models/User.js";
import upload, { requireImageContent } from "../../middleware/upload.js";
import { anonymousUploadLimiter, lookupLimiter, uploadLimiter } from "../../middleware/otpLimiter.js";
import { areKnownUploads, rememberAnonymousUploads } from "../../utils/images.js";
import { brokerAuth } from "../../middleware/auth.js";
import { notify } from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";
import { uploadToImageKit } from "../../utils/utils.js";
import { normalizeEmail } from "../../utils/constants.js";
import {
  HttpError,
  resolvePaidOrder,
  saveOrder,
  sendHttpError,
} from "../../utils/payments.js";
import { findReferralBroker } from "../../utils/orderBuilders.js";

const router = Router();

const brokerView = (b) => ({
  _id: b._id,
  name: b.name,
  email: b.email,
  phone: b.phone,
  companyName: b.companyName,
  address: b.address,
  note: b.note,
  caste: b.caste,
  motherTongue: b.motherTongue,
  referralId: b.referralId,
  status: b.referralId && b.status !== "suspended" ? "approved" : b.status,
  createdAt: b.createdAt,
});

router.get("/broker-validation", lookupLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    const phone = typeof req.query.mobile === "string" ? req.query.mobile : "";
    if (!email && !phone) {
      return res.status(400).json({ msg: "Email or Mobile is required" });
    }
    await dbConnect();
    if (email && (await Broker.exists({ email }))) {
      return res.status(400).json({ msg: "Email already exists" });
    }
    if (phone && (await Broker.exists({ phone }))) {
      return res.status(400).json({ msg: "Mobile number already registered" });
    }
    return res.json({ success: true, msg: "Valid" });
  } catch (err) {
    console.error("Broker Validation Error:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

router.post(
  "/broker-register/upload-idproof",
  uploadLimiter,
  anonymousUploadLimiter,
  upload.array("images", 3),
  requireImageContent,
  async (req, res) => {
    try {
      const files = /** @type {any[]} */ (req.files || []);
      if (!files.length) return res.status(400).json({ msg: "No images uploaded" });
      const media = [];
      for (const file of files) {
        const result = /** @type {any} */ (
          await uploadToImageKit(file.buffer, file.originalname, "/broker_id_proofs", true)
        );
        media.push({ url: result.url, fileId: result.fileId });
      }
      await rememberAnonymousUploads(media);
      return res.json({ media });
    } catch (err) {
      console.error("Broker ID proof upload error:", err);
      return res.status(500).json({ msg: "Failed to upload ID proof" });
    }
  }
);

/**
 * Completes a paid partner sign-up from the order record saved at
 * /create-order. Safe to call twice (browser + webhook). The account starts
 * "pending": an admin approves it, which issues the referral ID.
 */
router.post("/broker-register", async (req, res) => {
  try {
    await dbConnect();
    const { record, orderId, paymentId } = await resolvePaidOrder(req, "broker");
    const data = record.broker;

    let idProofs = (Array.isArray(req.body?.idProofs) ? req.body.idProofs : [])
      .filter((i) => i && typeof i.url === "string" && i.url.startsWith("https://") && typeof i.fileId === "string")
      .slice(0, 3)
      .map((i) => ({ url: i.url, fileId: i.fileId }));
    // Only files uploaded through /broker-register/upload-idproof.
    if (idProofs.length && !(await areKnownUploads(idProofs))) idProofs = [];

    const existing = await Broker.findOne({ email: data.email });
    if (existing) {
      if (existing.transactions.some((t) => t.orderId === orderId)) {
        if (idProofs.length && !existing.idProofs.length) {
          existing.idProofs = idProofs;
          await existing.save();
        }
        return res.json({ success: true, msg: "Registration received" });
      }
      throw new HttpError(
        409,
        `This email is already registered as a partner. If you were charged, please contact support with payment ID ${paymentId}.`
      );
    }

    await Broker.create({
      name: data.name,
      email: data.email,
      phone: data.phone,
      companyName: data.companyName,
      address: data.address,
      note: data.note,
      caste: data.caste,
      motherTongue: data.motherTongue,
      password: data.passwordHash,
      idProofs,
      status: "pending",
      transactions: [
        { orderId, paymentId, amountPaid: record.amountCharged, note: record.note },
      ],
    });

    await saveOrder(orderId, {
      ...record,
      broker: { ...data, passwordHash: undefined },
      fulfilled: true,
      paymentId,
    });

    notify({
      to: [{ email: data.email }],
      template_id: "broker_registration",
      variables: {
        userName: data.name,
        paymentId,
        amount: record.amountCharged,
      },
    });

    return res.status(201).json({ success: true, msg: "Registration received" });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error("Broker registration error:", err);
    return sendHttpError(
      res,
      err,
      "Partner registration failed after payment. Please contact support with your payment ID."
    );
  }
});

router.get("/validate-referral/:referralId", async (req, res) => {
  try {
    await dbConnect();
    const code = String(req.params.referralId || "").trim().toUpperCase();
    const broker = await findReferralBroker(code);
    return res.json(
      broker
        ? { valid: true, msg: "Valid referral ID" }
        : { valid: false, msg: "Invalid referral ID" }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, msg: "Server error" });
  }
});

/** The logged-in partner's own account. */
router.get("/broker/me", brokerAuth, async (req, res) => {
  // @ts-ignore
  const broker = req.broker;
  const usersReferred = broker.referralId
    ? await User.countDocuments({ "basic.referralId": broker.referralId })
    : 0;
  return res.json({ profile: { ...brokerView(broker), usersReferred } });
});

export { brokerView };
export default router;
