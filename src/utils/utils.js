import imageKit from "../config/imageKit.js";
import { nanoid } from "nanoid";

export const generateUniqueId = async (userCount) => {
  return nanoid(6);
};

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
