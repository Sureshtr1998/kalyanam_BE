import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import imageKit from "../../config/imageKit.js";
import transporter from "../../config/nodeMailer.js";
import User from "../../models/User.js";

const router = Router();
router.delete("/delete-account", auth, async (req, res) => {
  try {
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
          await imagekit.deleteFile(image.fileId);
        } catch (err) {
          console.error("Error deleting ImageKit image:", err.message);
        }
      }
    }

    await User.findByIdAndDelete(userId);

    await transporter.sendMail({
      from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
      to: user.basic.email,
      subject: "Account Deletion Confirmation",
      html: `
    <div style="font-family:Arial,sans-serif;">
      <h3>Account Deletion</h3>
      <p>Hello ${user.basic.fullName || ""},</p>
      <p>Your account has been successfully deleted. We are sorry to see you go!</p>
      <p>If this was a mistake, please contact our support team immediately.</p>
      <p>Thank you for using Seetha Rama Kalyana.</p>
    </div>
  `,
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
    const { userId } = req.body || {};
    // @ts-ignore
    const currentUserId = req.user.id;

    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (!userId) {
      currentUser.isHidden = true;
      await currentUser.save();

      await transporter.sendMail({
        from: `"Seetha Rama Kalyana Support" <${process.env.EMAIL_USER}>`,
        to: currentUser.basic.email,
        subject: "Account Hidden Successfully",
        html: `
    <div style="font-family:Arial,sans-serif;">
      <h3>Account Hidden</h3>
      <p>Hello ${currentUser.basic.fullName || ""},</p>
      <p>Your profile has been successfully hidden. You will be logged out.</p>
      <p>Your profile will automatically become visible again when you log in next time.</p>
      <p>If you did not request this, please contact our support team.</p>
      <p>Thank you for using Seetha Rama Kalyana.</p>
    </div>
  `,
      });

      return res.status(200).json({
        success: true,
        msg: "Your profile is now hidden",
      });
    }

    if (!currentUser.hideProfiles.includes(userId)) {
      currentUser.hideProfiles.push(userId);
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
