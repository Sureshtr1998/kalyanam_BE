import mongoose from "mongoose";
const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    //Registration details
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    fullName: { type: String },
    mobile: { type: String, unique: true },
    alternateMob: { type: String },
    dob: { type: Date },
    gender: { type: String },
    martialStatus: { type: String },
    motherTongue: { type: String },
    profileCreatedBy: { type: String },
    gotra: { type: String },
    subCaste: { type: String },
    age: { type: Number },
    images: [{ type: String }],
    qualification: { type: String },
    bNote: { type: String },

    //Personal Details
    height: { type: String },
    country: { type: String },
    residingStatus: { type: String },
    weight: { type: Number },
    diet: { type: String },
    address: { type: String },
    salary: { type: Number },
    employedIn: { type: String },
    rashi: { type: String },
    nakshatra: { type: String },
    mNote: { type: String },

    //Family details
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
    fNote: { type: String },

    //Partner preference
    ageFrom: { type: String },
    ageTo: { type: String },
    pMartialStatus: { type: [String] },
    heightFrom: { type: String },
    heightTo: { type: String },
    pSubCaste: { type: [String] },
    pEmployedIn: { type: [String] },
    pQualification: { type: [String] },
    pCountry: { type: [String] },
    pNote: { type: String },

    //Mis
    hasCompleteProfile: { type: Boolean, default: false },
    uniqueId: { type: String, unique: true },
    isHidden: { type: Boolean, default: false },
    hideProfiles: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    //Interests

    sent: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    received: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    accepted: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    declined: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    invitationStatus: { type: [String] },
  },
  { timestamps: true }
);

const User = model("User", userSchema);

export default User;
