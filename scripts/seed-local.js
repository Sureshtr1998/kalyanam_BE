/*
 * Local test data: ~46 members, an admin, two partners and some interests
 * between them. Run from kalyanam_BE:
 *
 *   node scripts/seed-local.js
 *
 * Safe to re-run: it first removes everything it created before (all
 * accounts on the @kalyanam.test domain) and leaves other data alone.
 * Refuses to run against anything but a local MongoDB.
 *
 * Every seeded account uses the password below.
 *   Admin member:       admin@kalyanam.test
 *   Partner (approved): partner@kalyanam.test   (tick "I am a registered matchmaker partner")
 *   Partner (pending):  pending@kalyanam.test
 *   Members:            seed01@kalyanam.test … seed46@kalyanam.test
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../src/models/User.js";
import Broker from "../src/models/Broker.js";

const PASSWORD = "123456";
const DOMAIN = "@kalyanam.test";
const PARTNER_CODE = "SRKTEST";

const uri = process.env.MONGO_URI || "";
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri)) {
  console.error(`Refusing to seed: MONGO_URI is not a local database (${uri.replace(/\/\/[^@]*@/, "//***@")}).`);
  process.exit(1);
}

// Deterministic "random" so every run produces the same people.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const BRIDES = [
  "Ananya Rao", "Bhavana Sharma", "Chaitra Bhat", "Deepika Iyer", "Divya Hegde", "Gayathri Kulkarni",
  "Harini Joshi", "Kavya Acharya", "Lakshmi Murthy", "Meghana Shastry", "Nandini Upadhya", "Pallavi Deshpande",
  "Pooja Nayak", "Priya Venkatesh", "Rashmi Adiga", "Sahana Karanth", "Shruthi Ramesh", "Sneha Krishnan",
  "Spoorthi Holla", "Swathi Aithal", "Tejaswini Rao", "Vaishnavi Pai", "Varsha Kamath",
];
const GROOMS = [
  "Aditya Bhat", "Akash Hegde", "Anirudh Rao", "Arjun Iyer", "Bharath Joshi", "Chetan Kulkarni",
  "Darshan Acharya", "Ganesh Murthy", "Harsha Shastry", "Karthik Upadhya", "Kiran Deshpande", "Manoj Nayak",
  "Nikhil Venkatesh", "Pavan Adiga", "Prajwal Karanth", "Rahul Ramesh", "Rohan Krishnan", "Sachin Holla",
  "Sandeep Aithal", "Shashank Pai", "Srinivas Kamath", "Varun Sharma", "Vinay Rao",
];
const TONGUES = ["Kannada", "Kannada", "Kannada", "Tamil", "Telugu", "Hindi", "Marathi", "Malayalam", "Havyaka Kannada"];
const SUBCASTES = ["Smartha", "Madhwa", "Havyaka", "Iyer", "Iyengar", "Deshastha", "Hoysala", "Shivalli (Madhva)", "Niyogi", "Vaidiki"];
const GOTHRAS = ["Bharadwaja", "Kashyapa", "Atreya", "Kaundinya", "Vishwamitra", "Shandilya", "Gautama"];
const QUALS = ["btech", "mtech", "mca", "bcom", "mba", "bsc", "msc", "ca", "mbbs", "bca", "ba"];
const WORK = ["Private", "Private", "Private", "Government", "PSU", "Business", "Self Employed"];
const CITIES = ["Bengaluru", "Mysuru", "Mangaluru", "Udupi", "Hubballi", "Chennai", "Hyderabad", "Pune", "Mumbai", "Shivamogga"];
const DIETS = ["Vegetarian", "Vegetarian", "Vegetarian", "Eggetarian"];
const RASHIS = ["Mesh", "Vrishabh", "Mithun", "Karka", "Simha", "Kanya", "Tula", "Vrischik", "Dhanu", "Makar", "Kumbh", "Meen"];
const NAKSHATRAS = ["Ashwini", "Rohini", "Mrigashira", "Pushya", "Magha", "Hasta", "Chitra", "Swati", "Anuradha", "Shravana", "Revati"];
const FATHERS = ["Ramesh", "Suresh", "Venkatesh", "Krishna Murthy", "Narayana", "Subramanya", "Raghavendra", "Prakash"];
const MOTHERS = ["Lalitha", "Sharada", "Saraswathi", "Vijaya", "Kamala", "Padma", "Geetha", "Usha"];

// Heights must be values from the height dropdown (cm).
const HEIGHTS_F = ["150", "152", "155", "157", "160", "163", "165", "168", "170"];
const HEIGHTS_M = ["165", "168", "170", "173", "175", "178", "180", "183", "185"];

const day = 86400000;
const floatingDob = (age) => {
  const d = new Date(Date.now() - age * 365.25 * day - between(0, 330) * day);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const photo = (gender, i) =>
  `https://randomuser.me/api/portraits/${gender === "Female" ? "women" : "men"}/${(i * 7) % 90}.jpg`;

const member = (i, name, gender, hash, overrides = {}) => {
  const female = gender === "Female";
  const age = female ? between(22, 33) : between(25, 37);
  const tongue = pick(TONGUES);
  const referred = overrides.referralId;
  const createdAt = new Date(Date.now() - between(0, 60) * day - between(0, 23) * 3600000);
  const strictTongue = i % 5 === 0; // some members only want their own language
  return {
    basic: {
      fullName: name,
      martialStatus: i % 17 === 0 ? "Divorced" : "Unmarried",
      email: `seed${String(i).padStart(2, "0")}${DOMAIN}`,
      qualification: pick(QUALS),
      password: hash,
      caste: "Brahmin",
      subCaste: pick(SUBCASTES),
      gothra: pick(GOTHRAS),
      mobile: `9${String(700000000 + i * 1234567).slice(0, 9)}`,
      gender,
      motherTongue: tongue,
      dob: floatingDob(age),
      profileCreatedBy: pick(["Self", "Self", "Parent", "Sibling"]),
      images: [{ url: photo(gender, i), fileId: `seed_${i}_1` }],
      note: `${female ? "I am" : "I'm"} a ${pick(["cheerful", "family-oriented", "calm", "curious"])} person who enjoys ${pick(["music", "travel", "cooking", "reading", "trekking"])} and values tradition.`,
      uniqueId: `SD${String(i).padStart(4, "0")}`,
      referralId: referred,
    },
    personal: {
      height: pick(female ? HEIGHTS_F : HEIGHTS_M),
      workCity: pick(CITIES),
      country: "India",
      residingStatus: "Indian",
      weight: female ? between(48, 68) : between(60, 85),
      diet: pick(DIETS),
      address: `${between(1, 400)}, ${pick(["2nd Main", "4th Cross", "MG Road", "Temple Street"])}, ${pick(CITIES)}`,
      salary: between(4, 40), // lakhs per annum, as members enter it
      employedIn: pick(WORK),
      rashi: pick(RASHIS),
      nakshatra: pick(NAKSHATRAS),
    },
    family: {
      familyStatus: pick(["Middle Class", "Upper Middle Class", "Rich"]),
      fatherName: `${pick(FATHERS)} ${name.split(" ")[1]}`,
      fatherStatus: "Alive",
      fatherOccup: pick(["Retired", "Business", "Teacher", "Engineer"]),
      motherName: `${pick(MOTHERS)} ${name.split(" ")[1]}`,
      motherStatus: "Alive",
      motherOccup: pick(["Homemaker", "Teacher", "Bank employee"]),
    },
    partner: {
      ageFrom: String(female ? age : Math.max(21, age - 8)),
      ageTo: String(female ? age + 8 : age),
      caste: ["Brahmin"],
      motherTongue: strictTongue ? [tongue] : [],
      employedIn: [],
      martialStatus: [],
    },
    interests: { totalNoOfInterest: 36, sent: [], received: [], accepted: [], declined: [], viewed: [] },
    transactions: [
      {
        orderId: `seed_order_${i}`,
        paymentId: `seed_pay_${i}`,
        note: "Registration",
        amountPaid: referred ? 301 : 351,
        noOfInterest: 36,
        dateOfTrans: createdAt,
      },
    ],
    hasCompleteProfile: true,
    isVerified: i % 3 !== 0,
    isHidden: false,
    lastActiveAt: new Date(Date.now() - between(0, 20) * day),
    createdAt,
  };
};

const run = async () => {
  await mongoose.connect(uri);
  const hash = await bcrypt.hash(PASSWORD, 10);

  // Clean up the previous run, including references to those members.
  const old = await User.find({ "basic.email": { $regex: `${DOMAIN.replace(".", "\\.")}$` } }).select("_id");
  const oldIds = old.map((u) => u._id);
  if (oldIds.length) {
    await User.updateMany(
      {},
      {
        $pull: {
          "interests.sent": { $in: oldIds },
          "interests.received": { $in: oldIds },
          "interests.accepted": { $in: oldIds },
          "interests.declined": { $in: oldIds },
          "interests.viewed": { $in: oldIds },
          hideProfiles: { $in: oldIds },
          shortlisted: { $in: oldIds },
          profileViews: { user: { $in: oldIds } },
        },
      }
    );
    await User.deleteMany({ _id: { $in: oldIds } });
  }
  await Broker.deleteMany({ email: { $regex: `${DOMAIN.replace(".", "\\.")}$` } });

  // Partners created before approval existed: those with a code are approved.
  await Broker.updateMany({ referralId: { $exists: true, $ne: null }, status: { $exists: false } }, { status: "approved" });
  await Broker.updateMany({ status: { $exists: false } }, { status: "pending" });

  await Broker.collection.insertMany([
    {
      name: "Ravi Partner",
      email: `partner${DOMAIN}`,
      phone: "9000000001",
      companyName: "Ravi Matrimony Services",
      address: "Jayanagar, Bengaluru",
      note: "Test partner",
      caste: ["Brahmin"],
      motherTongue: ["Kannada"],
      password: hash,
      idProofs: [],
      status: "approved",
      referralId: PARTNER_CODE,
      transactions: [{ orderId: "seed_partner", paymentId: "seed_partner_pay", amountPaid: 501, note: "Partner registration", dateOfTrans: new Date() }],
      createdAt: new Date(Date.now() - 70 * day),
      updatedAt: new Date(),
    },
    {
      name: "Pending Partner",
      email: `pending${DOMAIN}`,
      phone: "9000000002",
      companyName: "New Bandhan Bureau",
      address: "Mysuru",
      caste: ["Brahmin"],
      motherTongue: ["Kannada", "Tamil"],
      password: hash,
      idProofs: [],
      status: "pending",
      transactions: [{ orderId: "seed_pending", paymentId: "seed_pending_pay", amountPaid: 501, note: "Partner registration", dateOfTrans: new Date() }],
      createdAt: new Date(Date.now() - 2 * day),
      updatedAt: new Date(),
    },
  ]);

  const docs = [];
  let i = 1;
  BRIDES.forEach((name, k) => {
    docs.push(member(i, name, "Female", hash, k < 7 ? { referralId: PARTNER_CODE } : {}));
    i++;
  });
  GROOMS.forEach((name, k) => {
    docs.push(member(i, name, "Male", hash, k < 6 ? { referralId: PARTNER_CODE } : {}));
    i++;
  });

  // A few states worth testing.
  docs[3].isHidden = true; // hidden bride
  docs[30].isHidden = true; // hidden groom
  for (const d of [docs[8], docs[40]]) {
    // incomplete: missing required personal details
    d.hasCompleteProfile = false;
    d.personal = { workCity: d.personal.workCity };
  }
  docs[1].commissionPaidAt = new Date(Date.now() - 5 * day); // one commission already paid out

  // The admin is also a normal member (a groom).
  docs.push({
    ...member(i, "Admin Tester", "Male", hash),
    isAdmin: true,
    isVerified: true,
  });
  docs[docs.length - 1].basic.email = `admin${DOMAIN}`;
  docs[docs.length - 1].basic.uniqueId = "SDADMN";

  // `timestamps` is a real insertMany option that Mongoose's typings omit.
  const inserted = await User.insertMany(
    docs,
    /** @type {import("mongoose").InsertManyOptions} */ (/** @type {unknown} */ ({ timestamps: false }))
  );

  // Interests between seed01 (bride) and a few grooms, so Activity has data.
  const bride = inserted[0];
  const grooms = inserted.filter((u) => u.basic.gender === "Male" && !u.isHidden && u.hasCompleteProfile && !u.isAdmin);
  const [g1, g2, g3, g4] = grooms;
  const link = async (from, to, status) => {
    await User.updateOne({ _id: from._id }, { $push: { "interests.sent": to._id, ...(status ? { [`interests.${status}`]: to._id } : {}) } });
    await User.updateOne({ _id: to._id }, { $push: { "interests.received": from._id, ...(status ? { [`interests.${status}`]: from._id } : {}) } });
  };
  await link(g1, bride, "accepted"); // accepted: contact visible both ways
  await link(g2, bride, null); // waiting for the bride to respond
  await link(bride, g3, null); // bride is waiting
  await link(g4, bride, "declined");

  console.log(`Seeded ${inserted.length} members (${BRIDES.length} brides, ${GROOMS.length + 1} grooms incl. admin), 2 partners.`);
  console.log(`Partner referral ID: ${PARTNER_CODE}. Password for every seeded account is in this file.`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
