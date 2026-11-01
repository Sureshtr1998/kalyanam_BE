import mongoose from "mongoose";
import { cleanStrict } from "../utils/matching.js";
const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    basic: {
      fullName: { type: String, required: true },
      martialStatus: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      qualification: { type: String, required: true },
      password: { type: String, required: true },
      subCaste: { type: String, default: "" },
      caste: { type: String, default: "brahmin" },
      gothra: { type: String, default: "" },
      mobile: { type: String, required: true, unique: true },
      alternateMob: { type: String },
      gender: { type: String, required: true },
      motherTongue: { type: String, required: true },
      dob: { type: Date, default: null },
      profileCreatedBy: { type: String, required: true },
      images: {
        type: [
          {
            url: { type: String, required: true },
            fileId: { type: String, required: true },
          },
        ],
        default: [],
      },
      note: { type: String },
      uniqueId: { type: String, unique: true },
      referralId: { type: String },
    },
    personal: {
      height: { type: String },
      workCity: { type: String },
      country: { type: String },
      residingStatus: { type: String },
      weight: { type: Number },
      diet: { type: String },
      address: { type: String },
      salary: { type: Number },
      employedIn: { type: String },
      rashi: { type: String },
      nakshatra: { type: String },
      note: { type: String },
    },
    family: {
      familyStatus: { type: String },
      elderBro: { type: String },
      youngerBro: { type: String },
      elderSis: { type: String },
      youngerSis: { type: String },
      elderBroMar: { type: String },
      youngerBroMar: { type: String },
      elderSisMar: { type: String },
      youngerSisMar: { type: String },
      fatherName: { type: String },
      fatherStatus: { type: String },
      fatherOccup: { type: String },
      motherName: { type: String },
      motherStatus: { type: String },
      motherOccup: { type: String },
      note: { type: String },
    },
    partner: {
      ageFrom: { type: String },
      ageTo: { type: String },
      martialStatus: { type: [String] },
      heightFrom: { type: String },
      heightTo: { type: String },
      caste: { type: [String] },
      subCaste: { type: [String] },
      motherTongue: { type: [String] },
      employedIn: { type: [String] },
      note: { type: String },
      qualification: { type: [String] },
      country: { type: [String] },
      // Must-have preferences (see utils/matching.js). Left unset for members
      // who never chose, which keeps every preference a must-have.
      strict: { type: [String], default: undefined, set: cleanStrict },
    },
    interests: {
      viewed: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      sent: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      received: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      totalNoOfInterest: { type: Number },
      accepted: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      declined: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      // Other member id -> when the latest interest action with them happened
      // (sent, received, accepted or declined). Drives Activity sorting.
      actedAt: { type: Map, of: Date, default: {} },
      invitationStatus: {
        type: String,
        enum: ["accept", "decline", "sent", "received", "pending"],
        default: "pending",
      },
    },
    transactions: [
      {
        orderId: { type: String },
        paymentId: { type: String },
        note: { type: String },
        dateOfTrans: { type: Date, default: Date.now },
        amountPaid: { type: Number },
        noOfInterest: { type: Number },
        // Set when an admin refunds the payment (see /manage/users/:id/refund).
        refundId: { type: String },
        amountRefunded: { type: Number },
        refundedAt: { type: Date },
      },
    ],
    astrology: [
      {
        name: { type: String },
        mName: { type: String },
        uId: { type: String },
        dob: { type: Date },
        mDob: { type: Date },
        place: { type: String },
        mPlace: { type: String },
        // Birthplace coordinates, when picked from the place search.
        lat: { type: Number },
        lng: { type: Number },
        mLat: { type: Number },
        mLng: { type: Number },
        gender: { type: String },
        mGender: { type: String },
        consultationMode: { type: String },
        query: { type: String },
        generatedAt: { type: Date, default: Date.now },
        //Delayed
        status: { type: String },
        aiResponse: { type: String },
      },
    ],
    hasCompleteProfile: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    isHidden: { type: Boolean, default: false },
    // Policy violation: hidden from matches and unable to log in until an
    // admin clears it (see /manage/users/:id/corrupt).
    isCorrupted: { type: Boolean, default: false },
    // Admins use the site as normal members and also get the admin panel.
    // Only set directly in the database or by another admin.
    isAdmin: { type: Boolean, default: false },
    // Referral (basic.referralId holds the broker's code). The broker is paid
    // a commission per referred registration, outside the site.
    brokerUnlinked: { type: Boolean, default: false },
    commissionPaidAt: { type: Date },
    // Internal note visible only to admins / the member's broker.
    staffNote: { type: String },
    // Blocking is mutual: neither side sees the other in matches.
    hideProfiles: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    shortlisted: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    // Newest first, capped (see /profile-view).
    profileViews: {
      type: [
        {
          user: { type: mongoose.Schema.Types.ObjectId },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    lastActiveAt: { type: Date },
    // Tokens issued before this are refused (see middleware/auth.js).
    passwordChangedAt: { type: Date },
  },
  { timestamps: true }
);
userSchema.index({ createdAt: -1 });
userSchema.index({ "basic.gender": 1, isHidden: 1, hasCompleteProfile: 1 });
const User = model("User", userSchema);

export default User;
