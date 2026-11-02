import AbandonedCheckout from "../models/AbandonedCheckout.js";
import User from "../models/User.js";

/*
 * Abandoned registrations: people who reached Razorpay from the register form.
 * Recording never blocks checkout or fulfilment: every helper here logs and
 * swallows its own errors.
 */

export const EMAIL_LIMIT = 3;
export const EMAIL_GAP_MS = 24 * 60 * 60 * 1000;

const quietly = (label, fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    console.error(`Abandoned checkout (${label}) error:`, err);
    return null;
  }
};

/** A registration order was just created. ₹1 tester orders are left out. */
export const recordCheckout = quietly("record", async (record, amountCharged) => {
  if (record.purpose !== "registration" || amountCharged <= 1) return;
  const now = new Date();
  await AbandonedCheckout.updateOne(
    { email: record.email },
    {
      $set: {
        name: record.name,
        mobile: record.phone,
        profileCreatedBy: record.registration?.profileCreatedBy,
        amount: amountCharged,
        orderId: record.orderId,
        lastAttemptAt: now,
        status: "not_attempted",
      },
      $unset: { failureReason: 1 },
      $inc: { attempts: 1 },
      $addToSet: { orderIds: record.orderId },
    },
    { upsert: true }
  );
});

/** Razorpay `payment.failed`. Only the latest order counts, and paid stays paid. */
export const markCheckoutFailed = quietly("failed", async (orderId, reason) => {
  if (!orderId) return;
  await AbandonedCheckout.updateOne(
    { orderId, status: { $ne: "paid" } },
    { $set: { status: "failed", failureReason: String(reason || "Payment failed").slice(0, 200) } }
  );
});

/** Razorpay `order.paid` / `payment.captured`, or a fulfilled /user-register. */
export const markCheckoutPaid = quietly("paid", async (orderId) => {
  if (!orderId) return;
  await AbandonedCheckout.updateOne(
    { orderIds: orderId },
    { $set: { status: "paid" }, $unset: { failureReason: 1 } }
  );
});

const conversionUpdate = (row, joinedAt) => ({
  convertedAt: joinedAt,
  convertedAfterEmail: (row.emails ?? []).some((e) => e.ok && e.at < joinedAt),
});

/** A member just registered (paid or free): close any row for their email / mobile. */
export const markConverted = quietly("converted", async ({ email, mobile }, joinedAt = new Date()) => {
  const or = [email && { email }, mobile && { mobile }].filter(Boolean);
  if (!or.length) return;
  const rows = await AbandonedCheckout.find({ $or: or, convertedAt: null }).select("emails");
  await Promise.all(
    rows.map((row) =>
      AbandonedCheckout.updateOne({ _id: row._id }, { $set: conversionUpdate(row, joinedAt) })
    )
  );
});

/**
 * Catches members who joined some other way (a different flow, an admin
 * creating the account): any open row whose email or mobile now belongs to a
 * member is marked converted with that member's join date.
 */
export const syncConversions = async () => {
  const open = await AbandonedCheckout.find({ convertedAt: null })
    .select("email mobile emails")
    .lean();
  if (!open.length) return;
  const members = await User.find({
    $or: [
      { "basic.email": { $in: open.map((r) => r.email) } },
      { "basic.mobile": { $in: open.map((r) => r.mobile).filter(Boolean) } },
    ],
  })
    .select("basic.email basic.mobile createdAt")
    .lean();
  if (!members.length) return;
  const joinedBy = new Map();
  for (const m of members) {
    joinedBy.set(`e:${m.basic.email}`, m.createdAt);
    joinedBy.set(`m:${m.basic.mobile}`, m.createdAt);
  }
  await Promise.all(
    open.map((row) => {
      const joinedAt = joinedBy.get(`e:${row.email}`) ?? joinedBy.get(`m:${row.mobile}`);
      return joinedAt
        ? AbandonedCheckout.updateOne(
            { _id: row._id, convertedAt: null },
            { $set: conversionUpdate(row, joinedAt) }
          )
        : null;
    })
  );
};
