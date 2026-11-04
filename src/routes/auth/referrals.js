import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import dbConnect from "../../utils/dbConnect.js";
import { getPricing } from "../../utils/pricing.js";
import { ensureReferralCode } from "../../utils/referrals.js";

const router = Router();

/**
 * The Refer & earn tab: the member's code, what a friend saves and what the
 * member earns at the live pricing level, and every reward so far.
 */
router.get("/referral", auth, async (req, res) => {
  try {
    await dbConnect();
    // @ts-ignore
    const user = req.user;
    const [code, pricing] = await Promise.all([ensureReferralCode(user), getPricing()]);
    const rewards = [...(user.referralRewards ?? [])]
      .reverse()
      .map((r) => ({
        friendName: r.friendName || "A friend",
        amount: r.amount,
        status: r.status,
        createdAt: r.createdAt,
        paidAt: r.paidAt ?? null,
      }));
    const sum = (status) => rewards.filter((r) => r.status === status).reduce((n, r) => n + r.amount, 0);
    return res.json({
      code,
      level: pricing.level,
      reward: pricing.memberReferralReward,
      discount: Math.max(0, pricing.registrationFee - pricing.referralFee),
      friendFee: pricing.referralFee,
      registrationFee: pricing.registrationFee,
      rewards,
      totals: {
        joined: rewards.length,
        paid: sum("paid"),
        pending: sum("pending") + sum("processing"),
      },
    });
  } catch (err) {
    console.error("Referral error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

export default router;
