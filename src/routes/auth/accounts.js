import { Router } from "express";
import mongoose from "mongoose";
import { auth } from "../../middleware/auth.js";
import imageKit from "../../config/imageKit.js";
import User from "../../models/User.js";
import { notify } from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";

const router = Router();

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
        shortlisted: oid,
        profileViews: { user: oid },
      },
      $unset: { [`interests.actedAt.${oid}`]: "" },
    }
  );
};

router.delete("/delete-account", auth, async (req, res) => {
  try {
    await dbConnect();
    // @ts-ignore
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    await removeMember(user);

    notify({
      to: [{ email: user.basic?.email }],
      template_id: "account_deletion_3", // MSG91 Template ID
      variables: {
        user_name: user.basic?.fullName || "",
      },
    });

    res.status(200).json({
      success: true,
      msg: "Account and images deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting account:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/hide-profile", auth, async (req, res) => {
  try {
    await dbConnect();

    const { userId } = req.body || {};
    // @ts-ignore
    const currentUserId = req.user.id;

    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    //Hide current user profile
    if (!userId) {
      currentUser.isHidden = true;
      await currentUser.save();

      notify({
        to: [{ email: currentUser.basic?.email }],
        template_id: "account_hidden", // MSG91 Template ID
        variables: {
          user_name: currentUser.basic?.fullName || "",
        },
      });

      return res.status(200).json({
        success: true,
        msg: "Your profile is now hidden",
      });
    }

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, msg: "Invalid profile" });
    }

    if (!currentUser.hideProfiles.some((id) => id.equals(userId))) {
      currentUser.hideProfiles.unshift(userId);
      await currentUser.save();
    }

    return res.status(200).json({
      success: true,
      msg: "Profile hidden. You can unhide it from Activity → Hidden.",
      hideProfiles: currentUser.hideProfiles,
    });
  } catch (err) {
    console.error("Error hiding profile:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.get("/user-account", auth, async (req, res) => {
  try {
    await dbConnect();
    // @ts-ignore
    const currentUserId = req.user.id;

    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    res.status(200).json({
      success: true,
      isHidden: currentUser.isHidden,
    });
  } catch (err) {
    console.error("Error fetching account details:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
