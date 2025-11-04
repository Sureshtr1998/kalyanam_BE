import imageKit from "../config/imageKit.js";

export const generateUniqueId = async (userCount) => {
  const lettersIndex = Math.floor(userCount / 999);
  const number = (userCount % 999) + 1;

  const firstChar = String.fromCharCode(65 + Math.floor(lettersIndex / 26));
  const secondChar = String.fromCharCode(65 + (lettersIndex % 26));

  const numberStr = number.toString().padStart(3, "0");

  return `${firstChar}${secondChar}${numberStr}`;
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
