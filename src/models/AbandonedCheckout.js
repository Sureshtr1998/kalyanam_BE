import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * Someone who reached Razorpay from the registration form. One row per email:
 * retries update it (latest order + attempt count) instead of adding rows.
 * Kept for win-back emails from the admin panel; see utils/abandoned.js.
 */
const EmailLogSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    byName: { type: String },
    ok: { type: Boolean },
    // What MSG91 answered (or the error), for debugging delivery.
    response: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const AbandonedCheckoutSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String },
    mobile: { type: String, index: true },
    profileCreatedBy: { type: String },
    amount: { type: Number },
    // Latest order, plus every order this person has opened.
    orderId: { type: String },
    orderIds: { type: [String], index: true },
    // No default: /create-order's upsert $inc's it from 0.
    attempts: { type: Number },
    lastAttemptAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["not_attempted", "failed", "paid"],
      default: "not_attempted",
    },
    failureReason: { type: String },
    // Successful sends only; failed sends are in `emails` with ok: false.
    emailCount: { type: Number, default: 0 },
    lastEmailedAt: { type: Date },
    emails: { type: [EmailLogSchema], default: [] },
    convertedAt: { type: Date },
    convertedAfterEmail: { type: Boolean },
  },
  { timestamps: true, versionKey: false }
);

AbandonedCheckoutSchema.index({ lastAttemptAt: -1 });

export default model("AbandonedCheckout", AbandonedCheckoutSchema);
