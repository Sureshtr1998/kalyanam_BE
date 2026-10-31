import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import User from "../models/User.js";
import Broker from "../models/Broker.js";
import {
  ASTRO_FEES,
  BROKER_REGISTRATION_FEE,
  DISCOUNT_CODES,
  EMAIL_RE,
  INTEREST_PACKS,
  MOBILE_RE,
  PASSWORD_RULE_MSG,
  REFERRAL_REGISTRATION_FEE,
  REGISTRATION_FEE,
  REGISTRATION_INTERESTS,
  isValidPassword,
  normalizeEmail,
} from "./constants.js";
import { ageInYears, parseFloatingDate } from "./dates.js";
import { HttpError } from "./payments.js";
import { geocodePlace, validCoords } from "./astrology/astroHelper.js";
import { areKnownUploads } from "./images.js";

const str = (v, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const validImages = (images) =>
  Array.isArray(images) &&
  images.length >= 1 &&
  images.length <= 3 &&
  images.every(
    (img) =>
      img &&
      typeof img.url === "string" &&
      typeof img.fileId === "string" &&
      img.url.startsWith("https://")
  );

/** An approved, active broker by referral code, or null. */
export const findReferralBroker = (code) =>
  code
    ? Broker.findOne({ referralId: code, status: { $ne: "suspended" } }).select(
        "_id email phone"
      )
    : null;

/**
 * Price for a registration with the given (upper-cased) code.
 * Unknown codes are rejected rather than silently charged the normal fee, and
 * a broker can't take the referral discount on their own email / number.
 */
const registrationPrice = async (code, email, mobile) => {
  if (!code) return REGISTRATION_FEE;
  if (DISCOUNT_CODES.includes(code)) return REGISTRATION_FEE;
  const broker = await findReferralBroker(code);
  if (!broker) throw new HttpError(400, "Invalid referral ID");
  if (broker.email === email || broker.phone === mobile) {
    throw new HttpError(400, "You can't use your own referral ID");
  }
  return REFERRAL_REGISTRATION_FEE;
};

/**
 * Validates a registration before payment so nothing can fail after the
 * customer has been charged. Returns the order record to store in Redis.
 */
export const buildRegistrationOrder = async (body) => {
  const email = normalizeEmail(body.email);
  const mobile = str(body.mobile, 10);
  const data = {
    fullName: str(body.fullName, 80),
    email,
    mobile,
    alternateMob: str(body.alternateMob, 10),
    gender: str(body.gender, 10),
    motherTongue: str(body.motherTongue, 40),
    martialStatus: str(body.martialStatus, 30),
    profileCreatedBy: str(body.profileCreatedBy, 30),
    caste: str(body.caste, 80),
    subCaste: str(body.subCaste, 80),
    gothra: str(body.gothra, 60),
    qualification: str(body.qualification, 40),
    referralId: str(body.referralId, 10).toUpperCase(),
  };

  const missing = [
    "fullName",
    "gender",
    "motherTongue",
    "martialStatus",
    "profileCreatedBy",
    "caste",
    "qualification",
  ].filter((k) => !data[k]);
  if (missing.length) {
    throw new HttpError(400, "Please fill in all the required fields.");
  }
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (!MOBILE_RE.test(mobile)) {
    throw new HttpError(400, "Enter a valid 10-digit WhatsApp number.");
  }
  if (data.alternateMob && !MOBILE_RE.test(data.alternateMob)) {
    throw new HttpError(400, "Alternate number must be 10 digits.");
  }
  if (!["Male", "Female"].includes(data.gender)) {
    throw new HttpError(400, "Please select a gender.");
  }
  if (!isValidPassword(body.password)) throw new HttpError(400, PASSWORD_RULE_MSG);
  const dob = parseFloatingDate(body.dob);
  if (!dob || ageInYears(dob) < 18 || ageInYears(dob) > 100) {
    throw new HttpError(400, "Enter a valid date of birth (18 years or older).");
  }
  if (!validImages(body.images)) {
    throw new HttpError(400, "Please upload between 1 and 3 photos.");
  }
  if (!(await areKnownUploads(body.images))) {
    throw new HttpError(400, "Your photos have expired. Please upload them again.");
  }

  if (await User.exists({ "basic.email": email })) {
    throw new HttpError(400, "Email already registered");
  }
  if (await User.exists({ "basic.mobile": mobile })) {
    throw new HttpError(400, "Mobile number already registered");
  }

  return {
    purpose: "registration",
    email,
    phone: mobile,
    name: data.fullName,
    amount: await registrationPrice(data.referralId, email, mobile),
    interests: REGISTRATION_INTERESTS,
    note: "Registration",
    registration: {
      ...data,
      dob: dob.toISOString(),
      passwordHash: await bcrypt.hash(body.password, 10),
      images: body.images.map((i) => ({ url: i.url, fileId: i.fileId })),
    },
  };
};

const strList = (v, maxItems = 200) =>
  (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === "string" && x.trim())
    .slice(0, maxItems)
    .map((x) => x.trim().slice(0, 80));

/** Matchmaker partner sign-up, validated before payment like registrations. */
export const buildBrokerOrder = async (body) => {
  const email = normalizeEmail(body.email);
  const phone = str(body.phone, 10);
  const data = {
    name: str(body.name, 80),
    email,
    phone,
    companyName: str(body.companyName, 120),
    address: str(body.address, 300),
    note: str(body.note, 500),
    caste: strList(body.caste),
    motherTongue: strList(body.motherTongue),
  };
  if (!data.name || !data.companyName || !data.address || !data.caste.length) {
    throw new HttpError(400, "Please fill in all the required fields.");
  }
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (!MOBILE_RE.test(phone)) throw new HttpError(400, "Enter a valid 10-digit phone number.");
  if (!isValidPassword(body.password)) throw new HttpError(400, PASSWORD_RULE_MSG);
  if (await Broker.exists({ $or: [{ email }, { phone }] })) {
    throw new HttpError(400, "A partner is already registered with this email or phone");
  }
  return {
    purpose: "broker",
    email,
    phone,
    name: data.name,
    amount: BROKER_REGISTRATION_FEE,
    note: "Partner registration",
    broker: { ...data, passwordHash: await bcrypt.hash(body.password, 10) },
  };
};

export const buildInterestOrder = (user, pack) => {
  const plan = INTEREST_PACKS[pack];
  if (!plan) throw new HttpError(400, "Unknown interest pack");
  return {
    purpose: "interest",
    email: user.basic.email,
    phone: user.basic.mobile,
    name: user.basic.fullName,
    amount: plan.amount,
    interests: plan.interests,
    note: "Interest Purchase",
  };
};

const GENDERS = ["Male", "Female"];

const coordsOf = (lat, lng) => {
  const c = { lat: Number(lat), lng: Number(lng) };
  return lat != null && lng != null && validCoords(c) ? c : {};
};

export const buildAstroOrder = async (user, astro = {}) => {
  const consultationMode = astro.consultationMode;
  const amount = ASTRO_FEES[consultationMode];
  if (!amount) throw new HttpError(400, "Choose a consultation type");

  /** @type {Record<string, any>} */
  const entry = {
    consultationMode,
    name: str(astro.name, 80),
    place: str(astro.place, 120),
    gender: str(astro.gender, 10),
    dob: parseFloatingDate(astro.dob),
    ...coordsOf(astro.lat, astro.lng),
  };
  if (!entry.name || !entry.place || !entry.dob || !GENDERS.includes(entry.gender)) {
    throw new HttpError(400, "Name, date & time of birth, gender and place are required");
  }
  if (entry.dob > new Date()) throw new HttpError(400, "Birth date cannot be in the future");

  if (consultationMode === "Personalized") {
    entry.query = str(astro.query, 108);
    if (!entry.query) throw new HttpError(400, "Please enter your question");
  }
  if (consultationMode === "Kundli Matching") {
    entry.mName = str(astro.mName, 80);
    entry.mPlace = str(astro.mPlace, 120);
    entry.mGender = str(astro.mGender, 10);
    entry.mDob = parseFloatingDate(astro.mDob);
    const m = coordsOf(astro.mLat, astro.mLng);
    if (m.lat !== undefined) Object.assign(entry, { mLat: m.lat, mLng: m.lng });
    if (!entry.mName || !entry.mPlace || !entry.mDob || !GENDERS.includes(entry.mGender)) {
      throw new HttpError(400, "Please fill in all match profile details");
    }
  }

  // Resolve typed places now, so a typo is caught before the customer pays.
  // Places picked from the search list already carry coordinates.
  if (entry.lat === undefined) await geocodePlace(entry.place);
  if (entry.mPlace && entry.mLat === undefined) await geocodePlace(entry.mPlace);

  return {
    purpose: "astro",
    email: user.basic.email,
    phone: user.basic.mobile,
    name: user.basic.fullName,
    amount,
    note: `Astro_${consultationMode}`,
    astro: {
      ...entry,
      uId: nanoid(),
      dob: entry.dob.toISOString(),
      mDob: entry.mDob ? entry.mDob.toISOString() : undefined,
    },
  };
};
