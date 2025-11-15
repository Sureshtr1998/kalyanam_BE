import mongoose from "mongoose";
const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    basic: {
      fullName: { type: String, required: true },
      martialStatus: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      qualification: { type: String, required: true },
      password: { type: String, required: true },
      subCaste: { type: String, required: true },
      caste: { type: String, default: "brahmin" },
      gothra: { type: String, required: true },
      mobile: { type: String, required: true, unique: true },
      alternateMob: { type: String },
      gender: { type: String, required: true },
      motherTongue: { type: String, required: true },
      dob: { type: Date, default: null },
      age: { type: Number },
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
      subCaste: { type: [String] },
      employedIn: { type: [String] },
      note: { type: String },
      qualification: { type: [String] },
      country: { type: [String] },
    },
    interests: {
      sent: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      received: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      totalNoOfInterest: { type: Number },
      accepted: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      declined: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      invitationStatus: {
        type: String,
        enum: ["accept", "decline", "sent", "received", "pending"],
        default: "pending",
      },
    },
    transactions: [
      {
        orderId: { type: String },
        note: { type: String },
        dateOfTrans: { type: String },
        amountPaid: { type: Number },
        noOfInterest: { type: Number },
      },
    ],
    hasCompleteProfile: { type: Boolean, default: false },
    isHidden: { type: Boolean, default: false },
    hideProfiles: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);

const User = model("User", userSchema);

export default User;
