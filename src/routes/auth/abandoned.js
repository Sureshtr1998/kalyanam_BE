import { Router } from "express";
import mongoose from "mongoose";
import AbandonedCheckout from "../../models/AbandonedCheckout.js";
import User from "../../models/User.js";
import { adminOnly, staffAuth } from "../../middleware/auth.js";
import sendEmail from "../../config/msg91Email.js";
import dbConnect from "../../utils/dbConnect.js";
import { escapeRegex } from "../../utils/matching.js";
import {
  EMAIL_GAP_MS,
  EMAIL_LIMIT,
  markConverted,
  syncConversions,
} from "../../utils/abandoned.js";

/*
 * Abandoned registrations (admin): people who reached Razorpay from the
 * register form but haven't joined, and "complete your registration" emails
 * to win them back. Rows are written by /create-order and the Razorpay webhook.
 */

const router = Router();
router.use("/manage/abandoned", staffAuth, adminOnly);

const STATUSES = ["not_attempted", "failed", "paid"];
const PAGE_SIZE = 30;
const MAX_BULK = 50;

/** "YYYY-MM-DD" as the start of that day in IST, or null. */
const istDay = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? new Date(`${v}T00:00:00+05:30`) : null;

const listFilter = (q) => {
  /** @type {Record<string, any>} */
  const filter = {};
  if (STATUSES.includes(q.status)) filter.status = q.status;
  if (q.converted === "yes") filter.convertedAt = { $ne: null };
  if (q.converted === "no") filter.convertedAt = null;
  if (q.emailed === "never") filter.emailCount = { $in: [0, null] };
  if (q.emailed === "yes") filter.emailCount = { $gte: 1 };
  const from = istDay(q.from);
  const to = istDay(q.to);
  if (from || to) {
    filter.lastAttemptAt = {
      ...(from && { $gte: from }),
      // `to` is inclusive: everything before the next IST midnight.
      ...(to && { $lt: new Date(to.getTime() + 86400000) }),
    };
  }
  const search = String(q.q ?? "").trim().slice(0, 80);
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: re }, { email: re }, { mobile: re }];
  }
  return filter;
};

const rowView = (r) => ({
  id: r._id,
  name: r.name,
  email: r.email,
  mobile: r.mobile,
  profileCreatedBy: r.profileCreatedBy,
  amount: r.amount,
  attempts: r.attempts ?? 1,
  createdAt: r.createdAt,
  lastAttemptAt: r.lastAttemptAt,
  status: r.status,
  failureReason: r.failureReason,
  emailCount: r.emailCount ?? 0,
  lastEmailedAt: r.lastEmailedAt,
  lastEmailedBy: (r.emails ?? []).filter((e) => e.ok).pop()?.byName,
  convertedAt: r.convertedAt,
  convertedAfterEmail: !!r.convertedAfterEmail,
});

router.get("/manage/abandoned", async (req, res) => {
  try {
    await dbConnect();
    await syncConversions();
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const filter = listFilter(req.query);
    const [rows, total, summary] = await Promise.all([
      AbandonedCheckout.find(filter)
        .sort({ lastAttemptAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      AbandonedCheckout.countDocuments(filter),
      AbandonedCheckout.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            emailed: { $sum: { $cond: [{ $gte: ["$emailCount", 1] }, 1, 0] } },
            converted: { $sum: { $cond: [{ $ifNull: ["$convertedAt", false] }, 1, 0] } },
            convertedAfterEmail: { $sum: { $cond: ["$convertedAfterEmail", 1, 0] } },
          },
        },
      ]),
    ]);
    const s = summary[0] ?? { total: 0, emailed: 0, converted: 0, convertedAfterEmail: 0 };
    return res.json({
      rows: rows.map(rowView),
      total,
      page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      limits: { perPerson: EMAIL_LIMIT, gapHours: EMAIL_GAP_MS / 3600000 },
      summary: {
        total: s.total,
        emailed: s.emailed,
        converted: s.converted,
        convertedAfterEmail: s.convertedAfterEmail,
        // Of the people we emailed, how many joined after an email.
        emailConversionRate: s.emailed ? s.convertedAfterEmail / s.emailed : 0,
      },
    });
  } catch (err) {
    console.error("Manage abandoned error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * Claims one send for a row, atomically, so a double tap or two admins can't
 * go over the limits: not joined, under EMAIL_LIMIT, nothing in the last 24h.
 * Returns the row as it was before the claim, or null with the reason.
 */
const claimSend = async (id, now) => {
  const row = await AbandonedCheckout.findOneAndUpdate(
    {
      _id: id,
      convertedAt: null,
      emailCount: { $not: { $gte: EMAIL_LIMIT } },
      $or: [{ lastEmailedAt: null }, { lastEmailedAt: { $lte: new Date(now - EMAIL_GAP_MS) } }],
    },
    { $inc: { emailCount: 1 }, $set: { lastEmailedAt: new Date(now) } }
  ).lean();
  if (row) return { row };

  const current = await AbandonedCheckout.findById(id).lean();
  if (!current) return { reason: "Not found" };
  if (current.convertedAt) return { reason: "Already joined" };
  if ((current.emailCount ?? 0) >= EMAIL_LIMIT) return { reason: `Already emailed ${EMAIL_LIMIT} times` };
  return { reason: "Emailed in the last 24 hours" };
};

/** Sends the "complete your registration" email to one or more rows. */
router.post("/manage/abandoned/email", async (req, res) => {
  try {
    await dbConnect();
    const templateId = process.env.MSG91_TEMPLATE_COMPLETE_REGISTRATION;
    if (!templateId) {
      return res.status(500).json({ msg: "Email template is not configured on the server" });
    }
    const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [])];
    if (!ids.length || ids.length > MAX_BULK || !ids.every((id) => mongoose.isValidObjectId(id))) {
      return res.status(400).json({ msg: `Choose between 1 and ${MAX_BULK} people` });
    }
    // @ts-ignore
    const admin = req.user;

    const results = [];
    // One at a time: a handful of emails, and MSG91 errors stay per person.
    for (const id of ids) {
      const now = Date.now();
      const { row, reason } = await claimSend(id, now);
      if (!row) {
        results.push({ id, ok: false, msg: reason });
        continue;
      }
      // Someone who joined since the list was loaded must never get this email.
      const member = await User.findOne({
        $or: [{ "basic.email": row.email }, { "basic.mobile": row.mobile }],
      }).select("createdAt");
      if (member) {
        await AbandonedCheckout.updateOne(
          { _id: id },
          { $inc: { emailCount: -1 }, $set: { lastEmailedAt: row.lastEmailedAt ?? null } }
        );
        await markConverted({ email: row.email, mobile: row.mobile }, member.createdAt);
        results.push({ id, ok: false, msg: "Already joined" });
        continue;
      }

      const log = { at: new Date(now), by: admin._id, byName: admin.basic?.fullName };
      try {
        const response = await sendEmail({
          to: [{ email: row.email, name: row.name }],
          template_id: templateId,
          variables: { name: row.name },
        });
        await AbandonedCheckout.updateOne(
          { _id: id },
          { $push: { emails: { ...log, ok: true, response } } }
        );
        results.push({ id, ok: true, msg: "Sent" });
      } catch (err) {
        // Give the send back: a failed email shouldn't use up the person's quota.
        await AbandonedCheckout.updateOne(
          { _id: id },
          {
            $inc: { emailCount: -1 },
            $set: { lastEmailedAt: row.lastEmailedAt ?? null },
            $push: { emails: { ...log, ok: false, response: err?.response?.data ?? String(err?.message ?? err) } },
          }
        );
        results.push({ id, ok: false, msg: "Email provider error" });
      }
    }
    return res.json({ results, sent: results.filter((r) => r.ok).length });
  } catch (err) {
    console.error("Manage abandoned email error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

export default router;
