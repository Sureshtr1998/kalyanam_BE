import mongoose from "mongoose";
const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
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
    pincode: { type: String },
    images: [{ type: String }],
    qualification: { type: String },
  },
  { timestamps: true }
);

const User = model("User", userSchema);

export default User;
