import mongoose from "mongoose";
const { Schema, model } = mongoose;

const BrokerSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    referralId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },

    phone: {
      type: String,
      required: true,
      unique: true,
    },

    companyName: {
      type: String,
    },

    address: {
      type: String,
    },

    note: {
      type: String,
    },

    caste: {
      type: [String],
    },
    motherTongue: {
      type: [String],
    },

    password: {
      type: String,
      required: true,
      select: false, // 🔐 never return password
    },

    idProofs: {
      type: [
        {
          url: { type: String, required: true },
          fileId: { type: String, required: true },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

export default model("Broker", BrokerSchema);
