import { Router } from "express";
import mongoose from "mongoose";
import User from "../../models/User.js";
import Broker from "../../models/Broker.js";
import { adminOnly, staffAuth } from "../../middleware/auth.js";
import dbConnect from "../../utils/dbConnect.js";
import { notify } from "../../config/msg91Email.js";
import { generateBrokerId, signedImageUrl } from "../../utils/utils.js";
import { parseFloatingDate, ageInYears } from "../../utils/dates.js";
import {
  BROKER_COMMISSION,
  EMAIL_RE,
  MOBILE_RE,
  normalizeEmail,
} from "../../utils/constants.js";
import { escapeRegex } from "../../utils/matching.js";
import { deleteRemovedImages } from "../../utils/images.js";
import { EDITABLE, isComplete, pick } from "./profiles.js";
import { removeMember } from "./accounts.js";
import { brokerView } from "./broker.js";

/*
 * Member management for staff.
 *  - Admins (members with isAdmin) see and control every member.
 *  - Brokers see and control only members who registered with their referral
 *    code. They can't delete accounts, grant credits or touch payments; they
 *    can remove a member from their own list instead.
 * Every member lookup goes through `req.staff.scope`, so a broker asking for
 * someone else's member simply gets "not found".
 */

const router = Router();
router.use("/manage", staffAuth);

const DAY = 86400000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));

const findScoped = async (req, id, projection = "-basic.password") => {
  if (!mongoose.isValidObjectId(id)) return null;
  return User.findOne({ _id: oid(id), ...req.staff.scope }).select(projection);
};

const withMember = (handler) => async (req, res) => {
  try {
    await dbConnect();
    const user = await findScoped(req, req.params.id);
    if (!user) return res.status(404).json({ msg: "Member not found" });
    return await handler(req, res, user);
  } catch (err) {
    console.error("Manage error:", err);
    if (err?.code === 11000) {
      return res.status(400).json({ msg: "That email or mobile number is already used by another member" });
    }
    return res.status(500).json({ msg: "Server error" });
  }
};

const remainingCredits = (u) =>
  (u.interests?.totalNoOfInterest ?? 0) -
  ((u.interests?.sent?.length ?? 0) + (u.interests?.viewed?.length ?? 0) * 5);

/** What staff see for a member: everything except the password. */
const memberDetail = async (user, kind) => {
  const u = user.toObject();
  delete u.basic.password;
  const broker = u.basic.referralId
    ? await Broker.findOne({ referralId: u.basic.referralId }).select("name companyName referralId").lean()
    : null;
  return {
    ...u,
    // Payment details stay with admins.
    transactions: kind === "admin" ? u.transactions : undefined,
    astrology: kind === "admin" ? u.astrology : undefined,
    stats: {
      remainingCredits: remainingCredits(u),
      sent: u.interests?.sent?.length ?? 0,
      received: u.interests?.received?.length ?? 0,
      accepted: u.interests?.accepted?.length ?? 0,
      declined: u.interests?.declined?.length ?? 0,
      contactsViewed: u.interests?.viewed?.length ?? 0,
      blocked: u.hideProfiles?.length ?? 0,
      profileViews: u.profileViews?.length ?? 0,
      totalPaid: (u.transactions ?? []).reduce((s, t) => s + (t.amountPaid || 0), 0),
    },
    broker,
  };
};

// ───────────────────────── Overview ─────────────────────────

router.get("/manage/summary", async (req, res) => {
  try {
    await dbConnect();
    const { kind, scope } = req.staff;
    const now = Date.now();
    const count = (extra = {}) => User.countDocuments({ ...scope, ...extra });

    const [total, male, female, complete, verified, hidden, new7, new30, active7] =
      await Promise.all([
        count(),
        count({ "basic.gender": /^male$/i }),
        count({ "basic.gender": /^female$/i }),
        count({ hasCompleteProfile: true }),
        count({ isVerified: true }),
        count({ isHidden: true }),
        count({ createdAt: { $gte: new Date(now - 7 * DAY) } }),
        count({ createdAt: { $gte: new Date(now - 30 * DAY) } }),
        count({ lastActiveAt: { $gte: new Date(now - 7 * DAY) } }),
      ]);

    // New sign-ups per day for the last 14 days (IST).
    const signups = await User.aggregate([
      { $match: { ...scope, createdAt: { $gte: new Date(now - 14 * DAY) } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
          n: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const members = { total, male, female, complete, incomplete: total - complete, verified, hidden, new7, new30, active7 };

    if (kind === "broker") {
      // @ts-ignore
      const broker = req.broker;
      const code = broker.referralId;
      // Commission counts every registration made with the code, including
      // members the broker later removed from their list.
      const [referred, paidOut] = code
        ? await Promise.all([
            User.countDocuments({ "basic.referralId": code }),
            User.countDocuments({ "basic.referralId": code, commissionPaidAt: { $ne: null } }),
          ])
        : [0, 0];
      return res.json({
        kind,
        broker: brokerView(broker),
        members,
        signups,
        commission: {
          perMember: BROKER_COMMISSION,
          referred,
          earned: referred * BROKER_COMMISSION,
          paid: paidOut * BROKER_COMMISSION,
          due: (referred - paidOut) * BROKER_COMMISSION,
        },
      });
    }

    const [admins, revenueRows, interestRows, brokerRows, referralRows] = await Promise.all([
      count({ isAdmin: true }),
      User.aggregate([
        { $unwind: "$transactions" },
        {
          $group: {
            _id: {
              $switch: {
                branches: [
                  { case: { $eq: ["$transactions.note", "Registration"] }, then: "registration" },
                  { case: { $eq: ["$transactions.note", "Interest Purchase"] }, then: "credits" },
                  { case: { $regexMatch: { input: { $ifNull: ["$transactions.note", ""] }, regex: "^Astro_" } }, then: "astrology" },
                ],
                default: "other",
              },
            },
            total: { $sum: { $ifNull: ["$transactions.amountPaid", 0] } },
            last30: {
              $sum: {
                $cond: [
                  { $gte: ["$transactions.dateOfTrans", new Date(now - 30 * DAY)] },
                  { $ifNull: ["$transactions.amountPaid", 0] },
                  0,
                ],
              },
            },
            n: { $sum: 1 },
          },
        },
      ]),
      User.aggregate([
        {
          $group: {
            _id: null,
            sent: { $sum: { $size: { $ifNull: ["$interests.sent", []] } } },
            accepted: { $sum: { $size: { $ifNull: ["$interests.accepted", []] } } },
            contacts: { $sum: { $size: { $ifNull: ["$interests.viewed", []] } } },
          },
        },
      ]),
      Broker.aggregate([
        {
          $group: {
            _id: {
              $cond: [
                { $eq: ["$status", "suspended"] },
                "suspended",
                { $cond: [{ $ifNull: ["$referralId", false] }, "approved", "pending"] },
              ],
            },
            n: { $sum: 1 },
          },
        },
      ]),
      User.aggregate([
        { $match: { "basic.referralId": { $exists: true, $nin: ["", null] } } },
        { $lookup: { from: "brokers", localField: "basic.referralId", foreignField: "referralId", as: "b" } },
        { $match: { "b.0": { $exists: true } } },
        { $group: { _id: null, referred: { $sum: 1 }, paid: { $sum: { $cond: [{ $ifNull: ["$commissionPaidAt", false] }, 1, 0] } } } },
      ]),
    ]);

    const revenue = { total: 0, last30: 0, byType: {} };
    for (const r of revenueRows) {
      revenue.total += r.total;
      revenue.last30 += r.last30;
      revenue.byType[r._id] = { total: r.total, count: r.n };
    }
    const brokers = { total: 0, pending: 0, approved: 0, suspended: 0 };
    for (const b of brokerRows) {
      brokers[b._id] = b.n;
      brokers.total += b.n;
    }
    const ref = referralRows[0] ?? { referred: 0, paid: 0 };

    return res.json({
      kind,
      members: { ...members, admins },
      signups,
      revenue,
      interests: interestRows[0] ?? { sent: 0, accepted: 0, contacts: 0 },
      brokers,
      commission: {
        perMember: BROKER_COMMISSION,
        referred: ref.referred,
        paid: ref.paid * BROKER_COMMISSION,
        due: (ref.referred - ref.paid) * BROKER_COMMISSION,
      },
    });
  } catch (err) {
    console.error("Manage summary error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

// ───────────────────────── Members ─────────────────────────

const STATUS_FILTERS = {
  verified: { isVerified: true },
  unverified: { isVerified: { $ne: true } },
  hidden: { isHidden: true },
  complete: { hasCompleteProfile: true },
  incomplete: { hasCompleteProfile: { $ne: true } },
  admin: { isAdmin: true },
  referred: { "basic.referralId": { $exists: true, $nin: ["", null] } },
  commissionDue: { "basic.referralId": { $exists: true, $nin: ["", null] }, commissionPaidAt: null },
};

router.get("/manage/users", async (req, res) => {
  try {
    await dbConnect();
    const { scope } = req.staff;
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(String(req.query.limit)) || 20));
    const q = String(req.query.q || "").trim().slice(0, 80);
    const gender = String(req.query.gender || "");
    const status = String(req.query.status || "");
    const referralId = String(req.query.referralId || "").trim().toUpperCase();

    const match = { ...scope };
    /** @type {Record<string, any>[]} */
    const and = [];
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      and.push({
        $or: [
          { "basic.fullName": re },
          { "basic.email": re },
          { "basic.mobile": re },
          { "basic.uniqueId": re },
          { "basic.referralId": re },
        ],
      });
    }
    if (gender === "Male" || gender === "Female") and.push({ "basic.gender": new RegExp(`^${gender}$`, "i") });
    if (STATUS_FILTERS[status]) and.push(STATUS_FILTERS[status]);
    if (referralId && req.staff.kind === "admin") and.push({ "basic.referralId": referralId });
    if (and.length) match.$and = and;

    const sortKey = String(req.query.sort || "newest");
    /** @type {Record<string, 1 | -1>} */
    const sort =
      sortKey === "active" ? { lastActiveAt: -1 } : sortKey === "name" ? { "basic.fullName": 1 } : { createdAt: -1 };

    const [total, rows] = await Promise.all([
      User.countDocuments(match),
      User.aggregate([
        { $match: match },
        { $sort: sort },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            "basic.fullName": 1,
            "basic.uniqueId": 1,
            "basic.gender": 1,
            "basic.dob": 1,
            "basic.email": 1,
            "basic.mobile": 1,
            "basic.motherTongue": 1,
            "basic.caste": 1,
            "basic.referralId": 1,
            photo: { $arrayElemAt: ["$basic.images.url", 0] },
            isVerified: 1,
            isHidden: 1,
            isAdmin: 1,
            hasCompleteProfile: 1,
            brokerUnlinked: 1,
            commissionPaidAt: 1,
            createdAt: 1,
            lastActiveAt: 1,
            credits: {
              $subtract: [
                { $ifNull: ["$interests.totalNoOfInterest", 0] },
                {
                  $add: [
                    { $size: { $ifNull: ["$interests.sent", []] } },
                    { $multiply: [{ $size: { $ifNull: ["$interests.viewed", []] } }, 5] },
                  ],
                },
              ],
            },
            accepted: { $size: { $ifNull: ["$interests.accepted", []] } },
          },
        },
      ]),
    ]);

    return res.json({ rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Manage users error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

router.get(
  "/manage/users/:id",
  withMember(async (req, res, user) => res.json({ member: await memberDetail(user, req.staff.kind) }))
);

router.post(
  "/manage/users/:id/verify",
  withMember(async (req, res, user) => {
    user.isVerified = req.body?.value !== false;
    await user.save();
    return res.json({ msg: user.isVerified ? "Profile verified" : "Verification removed", member: await memberDetail(user, req.staff.kind) });
  })
);

router.post(
  "/manage/users/:id/hidden",
  withMember(async (req, res, user) => {
    user.isHidden = req.body?.value !== false;
    await user.save();
    return res.json({
      msg: user.isHidden ? "Profile hidden from everyone" : "Profile visible again",
      member: await memberDetail(user, req.staff.kind),
    });
  })
);

router.post(
  "/manage/users/:id/corrupt",
  adminOnly,
  withMember(async (req, res, user) => {
    user.isCorrupted = req.body?.value !== false;
    await user.save();
    return res.json({
      msg: user.isCorrupted ? "Profile flagged for policy violation" : "Policy flag removed",
      member: await memberDetail(user, req.staff.kind),
    });
  })
);

// Staff can also correct what members can't change themselves.
const STAFF_BASIC = ["fullName", "gender", "caste"];

router.post(
  "/manage/users/:id/profile",
  withMember(async (req, res, user) => {
    const body = req.body || {};
    const basic = pick(body.basic, [...EDITABLE.basic, ...STAFF_BASIC]);

    if (basic.fullName !== undefined && !String(basic.fullName).trim()) {
      return res.status(400).json({ msg: "Name can't be empty" });
    }
    if (basic.gender !== undefined && !["Male", "Female"].includes(basic.gender)) {
      return res.status(400).json({ msg: "Choose a gender" });
    }
    if (body.basic?.dob !== undefined) {
      const dob = parseFloatingDate(body.basic.dob);
      if (!dob || ageInYears(dob) < 18 || ageInYears(dob) > 100) {
        return res.status(400).json({ msg: "Enter a valid date of birth (18 years or older)" });
      }
      basic.dob = dob;
    }
    if (body.basic?.email !== undefined) {
      const email = normalizeEmail(body.basic.email);
      if (!EMAIL_RE.test(email)) return res.status(400).json({ msg: "Enter a valid email" });
      basic.email = email;
    }
    if (body.basic?.mobile !== undefined) {
      const mobile = String(body.basic.mobile).trim();
      if (!MOBILE_RE.test(mobile)) return res.status(400).json({ msg: "Enter a valid 10-digit mobile number" });
      basic.mobile = mobile;
    }
    // Photos can be removed or reordered here, not added.
    if (Array.isArray(body.basic?.images)) {
      const current = new Map(user.basic.images.map((i) => [i.fileId, i]));
      basic.images = body.basic.images
        .map((i) => current.get(i?.fileId))
        .filter(Boolean)
        .map((i) => ({ url: i.url, fileId: i.fileId }));
    }

    const imagesBefore = user.basic.images.map((i) => ({ fileId: i.fileId }));
    // Set fields one by one: the member was loaded without basic.password, so
    // replacing the whole `basic` object would drop it and fail validation.
    for (const [key, value] of Object.entries(basic)) user.set(`basic.${key}`, value);
    for (const section of ["personal", "family", "partner"]) {
      user.set(section, {
        ...(user[section]?.toObject?.() || {}),
        ...pick(body[section], EDITABLE[section]),
      });
    }
    if (typeof body.staffNote === "string") user.staffNote = body.staffNote.slice(0, 1000);
    user.hasCompleteProfile = isComplete(user);
    await user.save();
    void deleteRemovedImages(user._id, imagesBefore, user.basic.images);
    return res.json({ msg: "Profile saved", member: await memberDetail(user, req.staff.kind) });
  })
);

/** Broker: take a member off their list (the account itself stays). */
router.post(
  "/manage/users/:id/unlink",
  withMember(async (req, res, user) => {
    user.brokerUnlinked = true;
    await user.save();
    return res.json({ msg: "Removed from the partner's list" });
  })
);

router.post(
  "/manage/users/:id/relink",
  adminOnly,
  withMember(async (req, res, user) => {
    user.brokerUnlinked = false;
    await user.save();
    return res.json({ msg: "Back on the partner's list", member: await memberDetail(user, req.staff.kind) });
  })
);

router.post(
  "/manage/users/:id/credits",
  adminOnly,
  withMember(async (req, res, user) => {
    const amount = parseInt(req.body?.amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 500) {
      return res.status(400).json({ msg: "Enter a number of credits between -500 and 500" });
    }
    const total = (user.interests.totalNoOfInterest ?? 0) + amount;
    if (total < 0) return res.status(400).json({ msg: "Credits can't go below zero" });
    user.interests.totalNoOfInterest = total;
    user.transactions.unshift({
      orderId: `admin_${Date.now()}`,
      amountPaid: 0,
      noOfInterest: amount,
      // @ts-ignore
      note: `Credits ${amount > 0 ? "added" : "removed"} by admin (${req.user.basic.uniqueId})${req.body?.note ? `: ${String(req.body.note).slice(0, 120)}` : ""}`,
    });
    await user.save();
    return res.json({ msg: `${amount > 0 ? "Added" : "Removed"} ${Math.abs(amount)} credits`, member: await memberDetail(user, "admin") });
  })
);

router.post(
  "/manage/users/:id/admin",
  adminOnly,
  withMember(async (req, res, user) => {
    const value = req.body?.value === true;
    // @ts-ignore
    if (!value && String(user._id) === String(req.user._id)) {
      return res.status(400).json({ msg: "You can't remove your own admin access" });
    }
    user.isAdmin = value;
    await user.save();
    return res.json({ msg: value ? "Admin access granted" : "Admin access removed", member: await memberDetail(user, "admin") });
  })
);

router.post(
  "/manage/users/:id/commission",
  adminOnly,
  withMember(async (req, res, user) => {
    if (!user.basic.referralId) return res.status(400).json({ msg: "This member wasn't referred" });
    user.commissionPaidAt = req.body?.paid === false ? undefined : new Date();
    await user.save();
    return res.json({
      msg: user.commissionPaidAt ? "Commission marked as paid" : "Commission marked as due",
      member: await memberDetail(user, "admin"),
    });
  })
);

router.delete(
  "/manage/users/:id",
  adminOnly,
  withMember(async (req, res, user) => {
    // @ts-ignore
    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ msg: "Delete your own account from the Account page" });
    }
    await removeMember(user);
    return res.json({ msg: "Member deleted" });
  })
);

// ───────────────────────── Brokers (admin) ─────────────────────────

router.get("/manage/brokers", adminOnly, async (req, res) => {
  try {
    await dbConnect();
    const brokers = await Broker.find().sort({ createdAt: -1 }).lean();
    const counts = await User.aggregate([
      { $match: { "basic.referralId": { $in: brokers.map((b) => b.referralId).filter(Boolean) } } },
      {
        $group: {
          _id: "$basic.referralId",
          referred: { $sum: 1 },
          paid: { $sum: { $cond: [{ $ifNull: ["$commissionPaidAt", false] }, 1, 0] } },
          complete: { $sum: { $cond: ["$hasCompleteProfile", 1, 0] } },
        },
      },
    ]);
    const byCode = new Map(counts.map((c) => [c._id, c]));
    return res.json({
      brokers: brokers.map((b) => {
        const c = byCode.get(b.referralId) ?? { referred: 0, paid: 0, complete: 0 };
        return {
          ...brokerView(b),
          idProofs: (b.idProofs ?? []).map((p) => ({ fileId: p.fileId, url: signedImageUrl(p.url) })),
          paidFee: (b.transactions ?? []).map((t) => t.amountPaid || 0).reduce((s, n) => s + n, 0),
          lastActiveAt: b.lastActiveAt,
          referred: c.referred,
          complete: c.complete,
          commissionDue: (c.referred - c.paid) * BROKER_COMMISSION,
          commissionPaid: c.paid * BROKER_COMMISSION,
        };
      }),
    });
  } catch (err) {
    console.error("Manage brokers error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

router.post("/manage/brokers/:id/status", adminOnly, async (req, res) => {
  try {
    await dbConnect();
    const status = req.body?.status;
    if (!["approved", "suspended"].includes(status) || !mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ msg: "Invalid request" });
    }
    const broker = await Broker.findById(req.params.id);
    if (!broker) return res.status(404).json({ msg: "Partner not found" });

    // Only the first approval issues a code and emails it; reactivating doesn't.
    const firstApproval = status === "approved" && !broker.referralId;
    broker.status = status;
    if (firstApproval) {
      // Retry on the (unlikely) clash with an existing code.
      for (let i = 0; i < 5 && !broker.referralId; i++) {
        const code = generateBrokerId(broker.name);
        if (!(await Broker.exists({ referralId: code }))) broker.referralId = code;
      }
    }
    await broker.save();
    if (firstApproval) {
      notify({
        to: [{ email: broker.email }],
        template_id: "broker_confirmation",
        variables: { userName: broker.name, referralId: broker.referralId },
      });
    }
    return res.json({
      msg:
        status !== "approved"
          ? "Partner suspended"
          : firstApproval
            ? `Approved · referral ID ${broker.referralId} emailed to partner`
            : `Reactivated · referral ID ${broker.referralId}`,
      broker: brokerView(broker),
    });
  } catch (err) {
    console.error("Broker status error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/** Pay out every outstanding commission for a broker in one go. */
router.post("/manage/brokers/:id/settle", adminOnly, async (req, res) => {
  try {
    await dbConnect();
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ msg: "Invalid request" });
    const broker = await Broker.findById(req.params.id).lean();
    if (!broker?.referralId) return res.status(404).json({ msg: "Partner not found" });
    const result = await User.updateMany(
      { "basic.referralId": broker.referralId, commissionPaidAt: null },
      { commissionPaidAt: new Date() }
    );
    return res.json({
      msg: result.modifiedCount
        ? `Marked ₹${result.modifiedCount * BROKER_COMMISSION} as paid (${result.modifiedCount} members)`
        : "Nothing due",
    });
  } catch (err) {
    console.error("Broker settle error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

// ───────────────────────── Payments (admin) ─────────────────────────

router.get("/manage/payments", adminOnly, async (req, res) => {
  try {
    await dbConnect();
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = 30;
    const [rows, totalRows] = await Promise.all([
      User.aggregate([
        { $unwind: "$transactions" },
        { $sort: { "transactions.dateOfTrans": -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            _id: 0,
            userId: "$_id",
            name: "$basic.fullName",
            uniqueId: "$basic.uniqueId",
            referralId: "$basic.referralId",
            date: "$transactions.dateOfTrans",
            note: "$transactions.note",
            amount: "$transactions.amountPaid",
            credits: "$transactions.noOfInterest",
            paymentId: "$transactions.paymentId",
            orderId: "$transactions.orderId",
          },
        },
      ]),
      User.aggregate([{ $unwind: "$transactions" }, { $count: "n" }]),
    ]);
    const total = totalRows[0]?.n ?? 0;
    return res.json({ rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Manage payments error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

export default router;
