/*
 * Local only: fills the Refer & earn tab of one member with sample friends
 * and rewards, so the tab can be seen with data. Run from kalyanam_BE:
 *
 *   node scripts/seed-referrals-local.js [email]     # default suresh0@gmail.com
 *
 * Safe to re-run: it removes the friends it made before (refer-friendN@kalyanam.test,
 * also cleared by seed-local.js) and rebuilds the member's reward list.
 * Refuses to run against anything but a local MongoDB.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../src/models/User.js";
import { ensureReferralCode } from "../src/utils/referrals.js";

const email = (process.argv[2] || "suresh0@gmail.com").toLowerCase();
const uri = process.env.MONGO_URI || "";
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
  console.error(`Refusing to seed: MONGO_URI is not a local database (${uri.replace(/\/\/[^@]*@/, "//***@")}).`);
  process.exit(1);
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// name, gender, joined (days ago), reward status
const FRIENDS = [
  ["Kavya Acharya", "Female", 2, "processing"],
  ["Rahul Ramesh", "Male", 6, "paid"],
  ["Meghana Shastry", "Female", 15, "paid"],
  ["Arjun Iyer", "Male", 31, "pending"],
];

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });

const member = await User.findOne({ "basic.email": email });
if (!member) {
  console.error(`No member with email ${email} in this database.`);
  process.exit(1);
}
const code = await ensureReferralCode(member);

await User.deleteMany({ "basic.email": /^refer-friend\d+@kalyanam\.test$/ });

const password = await bcrypt.hash("123456", 4);
const rewards = [];
for (const [i, [fullName, gender, days, status]] of FRIENDS.entries()) {
  const n = i + 1;
  const friend = await User.create({
    basic: {
      fullName,
      email: `refer-friend${n}@kalyanam.test`,
      mobile: `90000001${String(n).padStart(2, "0")}`,
      password,
      gender,
      martialStatus: "Never Married",
      qualification: "btech",
      motherTongue: "Kannada",
      profileCreatedBy: "Self",
      caste: "Brahmin",
      dob: new Date("1996-03-10T00:00:00Z"),
      images: [],
      uniqueId: `RF${String(n).padStart(4, "0")}`,
    },
    interests: { totalNoOfInterest: 36 },
    referredBy: member._id,
    referredByCode: code,
    createdAt: daysAgo(days),
    transactions: [
      { orderId: `order_rf${n}`, paymentId: `pay_rf${n}`, amountPaid: 301, noOfInterest: 36, note: "Registration", dateOfTrans: daysAgo(days) },
    ],
  });
  rewards.push({
    friend: friend._id,
    friendName: String(fullName).split(" ")[0],
    amount: 71,
    status,
    createdAt: daysAgo(days),
    ...(status === "paid" ? { paymentId: "pay_local_test", refundId: `rfnd_local_${n}`, paidAt: daysAgo(days) } : {}),
    ...(status === "pending" ? { note: "No recent payment to refund to" } : {}),
  });
}

// Oldest first, like real rewards are added.
rewards.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
await User.updateOne({ _id: member._id }, { $set: { referralRewards: rewards } });

console.log(`${email}: code ${code}, ${rewards.length} friends added (2 paid, 1 processing, 1 pending).`);
await mongoose.disconnect();
