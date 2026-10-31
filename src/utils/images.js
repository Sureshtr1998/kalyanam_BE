import imageKit from "../config/imageKit.js";
import upStash, { publishQStash } from "../config/upStash.js";
import User from "../models/User.js";
import Broker from "../models/Broker.js";

// Photos uploaded before sign-up are remembered for as long as an order can
// stay payable (see ORDER_TTL_SECONDS in payments.js), then swept if unused.
const UPLOAD_PREFIX = "upload:";
const UPLOAD_TTL_SECONDS = 60 * 60 * 24 * 3;
const CLEANUP_DELAY = "4d";

/**
 * Records photos uploaded by someone not yet registered, and queues a check
 * that deletes them later if no account ended up using them. Never throws.
 */
export const rememberAnonymousUploads = async (media) => {
  const fileIds = media.map((m) => m.fileId);
  try {
    await Promise.all(
      fileIds.map((id) => upStash.set(`${UPLOAD_PREFIX}${id}`, "1", { ex: UPLOAD_TTL_SECONDS }))
    );
    await publishQStash("cleanup-uploads", { fileIds }, CLEANUP_DELAY);
  } catch (err) {
    console.error("Could not track anonymous upload:", err.message);
  }
};

/** Whether every image was uploaded through this server recently. */
export const areKnownUploads = async (images) => {
  const found = await Promise.all(images.map((i) => upStash.get(`${UPLOAD_PREFIX}${i.fileId}`)));
  return found.every(Boolean);
};

/** Deletes the given pre-sign-up uploads that no member or partner uses. Never throws. */
export const deleteUnclaimedUploads = async (fileIds = []) => {
  let deleted = 0;
  for (const fileId of fileIds.filter((id) => typeof id === "string").slice(0, 3)) {
    try {
      const used =
        (await User.exists({ "basic.images.fileId": fileId })) ||
        (await Broker.exists({ "idProofs.fileId": fileId }));
      if (!used) {
        await imageKit.deleteFile(fileId);
        deleted++;
      }
    } catch (err) {
      console.error("Error deleting unclaimed upload:", err.message);
    }
  }
  return deleted;
};

/**
 * Deletes from ImageKit the photos a member just removed from their profile.
 * Only files that were in `before`, are gone from `after`, and that no other
 * member references are deleted, so a client can't delete someone else's photo
 * by adding its fileId and then removing it. Never throws.
 */
export const deleteRemovedImages = async (userId, before = [], after = []) => {
  const kept = new Set(after.map((i) => i?.fileId));
  const removed = before.map((i) => i?.fileId).filter((id) => id && !kept.has(id));
  for (const fileId of removed) {
    try {
      const usedElsewhere = await User.exists({ _id: { $ne: userId }, "basic.images.fileId": fileId });
      if (!usedElsewhere) await imageKit.deleteFile(fileId);
    } catch (err) {
      console.error("Error deleting ImageKit image:", err.message);
    }
  }
};
