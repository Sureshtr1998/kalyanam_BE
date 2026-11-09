import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * Matchmaker partners. A broker registers (paid), an admin approves them and
 * that gives them a 7-character referral code. Members who register with the
 * code pay the referral fee and show up on the broker's dashboard.
 */
const BrokerSchema = new Schema(
  {
    name: { type: String, required: true },
    // Only set once approved; members can't use a code before that.
    referralId: { type: String, unique: true, sparse: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true, unique: true },
    companyName: { type: String },
    address: { type: String },
    note: { type: String },
    caste: { type: [String] },
    motherTongue: { type: [String] },
    password: { type: String, required: true, select: false },
    idProofs: {
      type: [
        {
          url: { type: String, required: true },
          fileId: { type: String, required: true },
        },
      ],
      default: [],
    },
    status: {
      type: String,
      enum: ["pending", "approved", "suspended", "rejected"],
      default: "pending",
    },
    transactions: [
      {
        orderId: { type: String },
        paymentId: { type: String },
        amountPaid: { type: Number },
        note: { type: String },
        dateOfTrans: { type: Date, default: Date.now },
        refundId: { type: String },
        amountRefunded: { type: Number },
        refundedAt: { type: Date },
      },
    ],
    // Why an admin turned the application down; shown in the email to them.
    rejectReason: { type: String },
    lastActiveAt: { type: Date },
    // Tokens issued before this are refused (see middleware/auth.js).
    passwordChangedAt: { type: Date },
  },
  { timestamps: true }
);

export default model("Broker", BrokerSchema);
