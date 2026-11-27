import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import { getPricing } from "../../utils/pricing.js";
import { HttpError, sendHttpError } from "../../utils/payments.js";
import { applyRenewal, canRenew, endDateOf, membershipSummary } from "../../utils/membership.js";

const router = Router();

/** The member's membership, renewal price and (when ended) what they're missing. */
router.get("/membership", auth, async (req, res) => {
  try {
    // @ts-ignore
    const user = req.user;
    const [summary, pricing] = await Promise.all([membershipSummary(user), getPricing()]);
    return res.json({
      ...summary,
      renewalFee: pricing.renewalFee,
      renewalInterests: pricing.renewalInterests,
      hiddenForInactivity: !!user.hiddenForInactivityAt && user.isHidden,
    });
  } catch (err) {
    return sendHttpError(res, err, "Could not load your membership");
  }
});

/** Renewal while the live pricing level makes it free (no Razorpay order). */
router.post("/membership/renew-free", auth, async (req, res) => {
  try {
    // @ts-ignore
    const user = req.user;
    if (!canRenew(user)) {
      throw new HttpError(400, "Your membership is active. Renewal opens 30 days before it ends.");
    }
    const pricing = await getPricing();
    if (pricing.renewalFee > 0) throw new HttpError(402, "Renewal needs payment. Please refresh the page.");
    // Keyed on the current end date, so a double click renews only once.
    const orderId = `free_renewal_${endDateOf(user).toISOString()}`;
    await applyRenewal(user._id, {
      orderId,
      paymentId: "free",
      amountPaid: 0,
      interests: pricing.renewalInterests,
      note: "Membership renewal (free)",
    });
    const fresh = await User.findById(user._id);
    return res.json({ ...(await membershipSummary(fresh)), msg: "Membership renewed" });
  } catch (err) {
    return sendHttpError(res, err, "Could not renew your membership");
  }
});

/** "Marriage fixed": hide the profile and stop every reminder. */
router.post("/membership/close", auth, async (req, res) => {
  try {
    // @ts-ignore
    const user = req.user;
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
    await User.updateOne(
      { _id: user._id },
      { $set: { marriedAt: new Date(), isHidden: true, ...(note ? { marriageNote: note } : {}) } }
    );
    return res.json({ msg: "Congratulations! Your profile is now closed and hidden from everyone." });
  } catch (err) {
    return sendHttpError(res, err, "Could not close your profile");
  }
});

/** Undo "Marriage fixed". */
router.post("/membership/reopen", auth, async (req, res) => {
  try {
    // @ts-ignore
    const user = req.user;
    await User.updateOne(
      { _id: user._id },
      { $set: { isHidden: false }, $unset: { marriedAt: 1, hiddenForInactivityAt: 1 } }
    );
    const fresh = await User.findById(user._id);
    return res.json({ ...(await membershipSummary(fresh)), msg: "Your profile is visible again" });
  } catch (err) {
    return sendHttpError(res, err, "Could not reopen your profile");
  }
});

export default router;
