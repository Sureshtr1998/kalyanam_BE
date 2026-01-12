import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";

const router = Router();

router.post("/corrupt-profile", auth, async (req, res) => {
  try {
    const { corruptedId } = req.body;

    const user = await User.findById(corruptedId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.isCorrupted = !user.isCorrupted;
    await user.save();

    res.json({
      message: "Corruption status updated",
      isCorrupted: user.isCorrupted,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
router.post("/verify-profile", auth, async (req, res) => {
  try {
    const { verifyUserId } = req.body;

    const user = await User.findById(verifyUserId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.isVerified = true;
    await user.save();

    res.json({
      message: "Verified status updated",
      isCorrupted: user.isCorrupted,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
