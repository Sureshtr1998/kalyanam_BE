import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * Site-wide settings an admin can change from the panel. A single document
 * with _id "global" (see utils/pricing.js).
 */
const SettingsSchema = new Schema(
  {
    _id: { type: String },
    // Which row of PRICING_LEVELS is live (1 = free registration).
    pricingLevel: { type: Number, min: 1, max: 4 },
    pricingUpdatedBy: { type: String },
    pricingUpdatedAt: { type: Date },
  },
  { versionKey: false }
);

export default model("Settings", SettingsSchema);
