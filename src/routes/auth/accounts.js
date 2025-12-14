import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import imageKit from "../../config/imageKit.js";
import User from "../../models/User.js";
import sendEmail from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";

const router = Router();
router.delete("/delete-account", auth, async (req, res) => {
  try {
    await dbConnect();
    // @ts-ignore
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    // @ts-ignore
    if (user.images && user.images.length > 0) {
      // @ts-ignore
      for (const image of user.images) {
        try {
          // @ts-ignore
          await imagekit.deleteFile(image.fileId);
        } catch (err) {
          console.error("Error deleting ImageKit image:", err.message);
        }
      }
    }

    await User.findByIdAndDelete(userId);

    await sendEmail({
      to: [{ email: user.basic.email }],
      template_id: "account_deletion_3", // MSG91 Template ID
      variables: {
        user_name: user.basic.fullName || "",
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

      await sendEmail({
        to: [{ email: currentUser.basic.email }],
        template_id: "account_hidden", // MSG91 Template ID
        variables: {
          user_name: currentUser.basic.fullName || "",
        },
      });

      return res.status(200).json({
        success: true,
        msg: "Your profile is now hidden",
      });
    }

    if (!currentUser.hideProfiles.includes(userId)) {
      currentUser.hideProfiles.unshift(userId);
      await currentUser.save();
    }

    return res.status(200).json({
      success: true,
      msg: "User profile hidden successfully",
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
