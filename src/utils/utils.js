import imageKit from "../config/imageKit.js";
import { customAlphabet } from "nanoid";

const nanoidCustom = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);

export const generateUniqueId = async () => nanoidCustom();

// No 0/O or 1/I so codes read clearly over the phone.
const referralSuffix = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

/** 7-character broker referral code: 3 letters of the name + 4 random. */
export const generateBrokerId = (name) =>
  `${String(name || "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, "X")}${referralSuffix()}`;

/**
 * Private files (ID proofs) can only be opened through a signed URL,
 * see signedImageUrl.
 */
export const uploadToImageKit = async (fileBuffer, fileName, folder, isPrivate = false) => {
  return new Promise((resolve, reject) => {
    imageKit.upload(
      {
        file: fileBuffer.toString("base64"),
        fileName,
        // Set IMAGEKIT_FOLDER=/test_profiles locally to keep test uploads apart.
        folder: folder || process.env.IMAGEKIT_FOLDER || "/user_profiles",
        isPrivateFile: isPrivate,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
  });
};

/** Short-lived link to a private ImageKit file. */
export const signedImageUrl = (url, expireSeconds = 600) =>
  imageKit.url({ src: url, signed: true, expireSeconds });
