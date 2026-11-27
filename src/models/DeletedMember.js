import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * Payment records of members whose account was deleted automatically after
 * long dormancy (utils/membership.js). Kept for tax and refunds; no profile
 * data, photos or contact details.
 */
const DeletedMemberSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId },
    uniqueId: { type: String },
    joinedAt: { type: Date },
    membershipEndsAt: { type: Date },
    reason: { type: String },
    transactions: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

export default model("DeletedMember", DeletedMemberSchema);
