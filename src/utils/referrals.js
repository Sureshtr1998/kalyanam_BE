import User from "../models/User.js";
import Broker from "../models/Broker.js";
import razorpay from "../config/razorpay.js";
import { notify } from "../config/msg91Email.js";
import { DISCOUNT_CODES } from "./constants.js";
import { generateBrokerId } from "./utils.js";

/*
 * Refer & earn for members.
 *
 * Every member has a 7-character code (same shape as a partner's, and never
 * equal to one). A friend who registers with it pays the level's referralFee;
 * once their registration is paid, the member who referred them gets the
 * level's memberReferralReward back as a partial Razorpay refund on one of
 * their own payments, so the money lands on whatever card / UPI / bank they
 * paid with. When no payment can take it (free sign-up, paid more than
 * REFUND_WINDOW_DAYS ago, already refunded, or Razorpay refuses) the reward is
 * kept as "pending" for staff to pay by hand.
 */

// Razorpay accepts refunds for roughly six months after capture; stay inside it.
export const REFUND_WINDOW_DAYS = 175;

const isCodeTaken = async (code) =>
  DISCOUNT_CODES.includes(code) ||
  !!(await Broker.exists({ referralId: code })) ||
  !!(await User.exists({ referralCode: code }));

/** A fresh member code that no member, partner or promo already uses. */
export const newMemberReferralCode = async (name) => {
  for (let i = 0; i < 8; i++) {
    const code = generateBrokerId(name);
    if (!(await isCodeTaken(code))) return code;
  }
  throw new Error("Could not generate a unique referral code");
};

/**
 * The member's code, creating it the first time (members who joined before
 * refer & earn existed). Safe against two requests racing to create it.
 */
export const ensureReferralCode = async (user) => {
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 3; i++) {
    const code = await newMemberReferralCode(user.basic?.fullName);
    try {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, referralCode: { $exists: false } },
        { $set: { referralCode: code } },
        { new: true, projection: { referralCode: 1 } }
      ).lean();
      if (updated) return (user.referralCode = updated.referralCode);
      // Someone else set it first.
      const fresh = await User.findById(user._id).select("referralCode").lean();
      if (fresh?.referralCode) return (user.referralCode = fresh.referralCode);
    } catch (err) {
      if (/** @type {{ code?: number }} */ (err)?.code !== 11000) throw err;
    }
  }
  throw new Error("Could not save a referral code");
};

/** The active member who owns a code, or null. */
export const findReferrerMember = (code) =>
  code
    ? User.findOne({ referralCode: code, isCorrupted: { $ne: true } }).select("_id basic.email basic.mobile")
    : null;

const refundableLeft = (t) =>
  (t.amountPaid ?? 0) - (t.referralRefunded ?? 0) - (t.amountRefunded ?? 0);

/**
 * The payment to send a reward back on: registration first, then the newest
 * other payment, as long as it is recent, not refunded and has room for it.
 */
export const pickRefundablePayment = (transactions = [], amount, now = new Date()) => {
  const since = now.getTime() - REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return (
    transactions
      .filter(
        (t) =>
          t.paymentId &&
          !t.refundedAt &&
          t.dateOfTrans &&
          new Date(t.dateOfTrans).getTime() >= since &&
          refundableLeft(t) >= amount
      )
      .sort((a, b) => {
        const reg = Number(b.note === "Registration") - Number(a.note === "Registration");
        return reg || new Date(b.dateOfTrans).getTime() - new Date(a.dateOfTrans).getTime();
      })[0] ?? null
  );
};

// MSG91 email template sent to the referrer when a friend joins with their code.
export const REFERRAL_JOINED_TEMPLATE = "referral_joined";

/**
 * Tells the referrer a friend joined. Only the friend's name is shared, never
 * their contact details.
 */
const emailReferrer = (referrer, friend, amount) =>
  referrer?.basic?.email
    ? notify({
        to: [{ email: referrer.basic.email, name: referrer.basic.fullName }],
        template_id: REFERRAL_JOINED_TEMPLATE,
        variables: {
          userName: referrer.basic.fullName,
          friendName: friend.basic?.fullName,
          amount,
        },
      })
    : undefined;

const setReward = (referrerId, friendId, fields) =>
  User.updateOne(
    { _id: referrerId, "referralRewards.friend": friendId },
    { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`referralRewards.$.${k}`, v])) }
  );

/**
 * Pays the referrer for one friend's registration. Never throws: the friend's
 * registration has already succeeded and must not fail because of this.
 * Runs at most once per friend (the reward entry is the lock).
 */
export const payReferralReward = async ({ referrerId, friend, amount }) => {
  if (!referrerId || !(amount > 0)) return null;
  try {
    const claimed = await User.updateOne(
      { _id: referrerId, "referralRewards.friend": { $ne: friend._id } },
      {
        $push: {
          referralRewards: {
            friend: friend._id,
            friendName: String(friend.basic?.fullName || "").split(" ")[0],
            amount,
            status: "processing",
          },
        },
      }
    );
    if (!claimed.modifiedCount) return null; // Already rewarded, or the referrer is gone.

    const referrer = await User.findById(referrerId).select("transactions basic.uniqueId basic.email basic.fullName");
    const payment = pickRefundablePayment(referrer?.transactions, amount);
    if (!payment) {
      await setReward(referrerId, friend._id, { status: "pending", note: "No recent payment to refund to" });
      await emailReferrer(referrer, friend, amount);
      return "pending";
    }

    // Reserve the amount on the payment before calling Razorpay.
    await User.updateOne(
      { _id: referrerId, "transactions.paymentId": payment.paymentId },
      { $inc: { "transactions.$.referralRefunded": amount } }
    );
    let refund;
    try {
      refund = await razorpay.payments.refund(payment.paymentId, {
        amount: amount * 100,
        speed: "normal",
        // @ts-ignore
        notes: { reason: "Referral reward", member: referrer?.basic?.uniqueId, friend: friend.basic?.uniqueId },
      });
    } catch (err) {
      await User.updateOne(
        { _id: referrerId, "transactions.paymentId": payment.paymentId },
        { $inc: { "transactions.$.referralRefunded": -amount } }
      );
      const reason = err?.error?.description || err?.message || "Razorpay refused the refund";
      console.error("Referral reward refund error:", err?.error || err);
      await setReward(referrerId, friend._id, { status: "pending", note: String(reason).slice(0, 200) });
      await emailReferrer(referrer, friend, amount);
      return "pending";
    }
    // Razorpay has the money moving now; from here on the reward is never
    // reopened as "pending", or staff could pay it twice.
    try {
      await setReward(referrerId, friend._id, {
        status: "paid",
        paymentId: payment.paymentId,
        refundId: refund.id,
        paidAt: new Date(),
      });
    } catch (err) {
      console.error(`Referral reward refunded (${refund.id}) but not recorded:`, err);
    }
    await emailReferrer(referrer, friend, amount);
    return "paid";
  } catch (err) {
    console.error("Referral reward error:", err);
    return null;
  }
};
