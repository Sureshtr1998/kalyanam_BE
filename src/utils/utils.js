import imageKit from "../config/imageKit.js";
import { customAlphabet } from "nanoid";

const nanoidCustom = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);

export const generateUniqueId = async () => nanoidCustom();

export const uploadToImageKit = async (fileBuffer, fileName) => {
  return new Promise((resolve, reject) => {
    imageKit.upload(
      {
        file: fileBuffer.toString("base64"),
        fileName,
        folder: "/user_profiles",
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
