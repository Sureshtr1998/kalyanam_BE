import imageKit from "../config/imageKit.js";
import User from "../models/User.js";

/** Deletes a member, their photos, and every reference other members hold to them. */
/** @param {InstanceType<typeof User>} user */
export const removeMember = async (user) => {
  for (const image of user.basic?.images || []) {
    try {
      await imageKit.deleteFile(image.fileId);
    } catch (err) {
      console.error("Error deleting ImageKit image:", /** @type {Error} */ (err).message);
    }
  }

  await User.findByIdAndDelete(user._id);

  // Drop dangling references so other members' lists don't show a ghost row.
  const oid = user._id;
  await User.updateMany(
    {
      $or: [
        { "interests.sent": oid },
        { "interests.received": oid },
        { "interests.accepted": oid },
        { "interests.declined": oid },
        { "interests.viewed": oid },
        { hideProfiles: oid },
        { skippedProfiles: oid },
        { shortlisted: oid },
        { "profileViews.user": oid },
      ],
    },
    {
      $pull: {
        "interests.sent": oid,
        "interests.received": oid,
        "interests.accepted": oid,
        "interests.declined": oid,
        "interests.viewed": oid,
        hideProfiles: oid,
        skippedProfiles: oid,
        shortlisted: oid,
        profileViews: { user: oid },
      },
      $unset: { [`interests.actedAt.${oid}`]: "" },
    }
  );
};
