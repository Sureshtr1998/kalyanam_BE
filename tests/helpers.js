import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import request from "supertest";
import app from "../src/index.js";
import User from "../src/models/User.js";
import Broker from "../src/models/Broker.js";
import dbConnect from "../src/utils/dbConnect.js";

export const api = () => request(app);

export const PASSWORD = "Secret@123";

let seq = 0;
const next = () => String(++seq).padStart(4, "0");

/** A complete, paid-up member, saved straight to the database. */
export const createUser = async (overrides = {}) => {
  await dbConnect();
  const n = next();
  return User.create({
    basic: {
      fullName: `Test Member ${n}`,
      email: `member${n}@example.test`,
      mobile: `98765${n.padStart(5, "0")}`,
      password: await bcrypt.hash(PASSWORD, 4),
      gender: "Male",
      martialStatus: "Never Married",
      qualification: "B.E",
      motherTongue: "Kannada",
      profileCreatedBy: "Self",
      caste: "Brahmin",
      dob: new Date("1995-01-01T00:00:00Z"),
      images: [{ url: "https://ik.example.test/a.jpg", fileId: "a" }],
      uniqueId: `U${n}`,
      ...overrides.basic,
    },
    interests: { totalNoOfInterest: 36, ...overrides.interests },
    ...overrides.rest,
  });
};

export const createBroker = async (overrides = {}) => {
  await dbConnect();
  const n = next();
  return Broker.create({
    name: `Partner ${n}`,
    email: `partner${n}@example.test`,
    phone: `91234${n.padStart(5, "0")}`,
    companyName: "Test Matchmakers",
    address: "Bengaluru",
    caste: ["Brahmin"],
    password: await bcrypt.hash(PASSWORD, 4),
    status: "approved",
    referralId: `REF${n}`,
    ...overrides,
  });
};

export const tokenFor = (user, role = "USER") =>
  jwt.sign({ id: user._id, role }, process.env.JWT_SECRET, { expiresIn: "1h" });

/** The signature Razorpay Checkout hands the browser after a successful payment. */
export const checkoutSignature = (orderId, paymentId) =>
  crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

export const paidOrder = (orderId, paymentId = `pay_${orderId}`) => ({
  orderId,
  paymentId,
  signature: checkoutSignature(orderId, paymentId),
});

export const webhookSignature = (body) =>
  crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");

/** A registration form that passes server-side validation. */
export const registrationForm = (overrides = {}) => ({
  fullName: "Asha Rao",
  email: "asha@example.test",
  mobile: "9876500001",
  gender: "Female",
  motherTongue: "Kannada",
  martialStatus: "Never Married",
  profileCreatedBy: "Self",
  caste: "Brahmin",
  qualification: "B.E",
  password: PASSWORD,
  dob: "1996-05-20",
  images: [{ url: "https://ik.example.test/asha.jpg", fileId: "asha" }],
  ...overrides,
});
