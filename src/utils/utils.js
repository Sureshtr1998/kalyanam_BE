import imageKit from "../config/imageKit.js";
import { customAlphabet } from "nanoid";

const nanoidCustom = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);

export const generateUniqueId = async () => nanoidCustom();

export const uploadToImageKit = async (fileBuffer, fileName, isPrivate) => {
  return new Promise((resolve, reject) => {
    imageKit.upload(
      {
        file: fileBuffer.toString("base64"),
        fileName,
        folder: isPrivate ? "/private_profiles" : "/user_profiles",
        isPrivateFile: Boolean(isPrivate),
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
  });
};

export const isTransactionExists = (transactions = [], orderId, paymentId) => {
  return transactions.some(
    (txn) => txn?.orderId === orderId || txn?.paymentId === paymentId
  );
};

export const generateBrokerId = (name) => {
  const prefix = name
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, "X");

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let randomCode = "";

  for (let i = 0; i < 4; i++) {
    randomCode += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return `${prefix}${randomCode}`;
};
