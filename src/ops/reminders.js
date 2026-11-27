import crypto from "crypto";
import mongoose from "mongoose";
import AbandonedCheckout from "../models/AbandonedCheckout.js";
import User from "../models/User.js";
import sendEmail from "../config/msg91Email.js";
import { syncConversions } from "../utils/abandoned.js";
import { sendMail, mailConfigured } from "./mail.js";
import { sendWhatsappTemplate, whatsappConfigured } from "./whatsapp.js";
import { notice } from "./actions.js";

/*
 * Reminders, run by the agent on every tick (owner's request, 27 Nov 2026):
 *  - unpaid: people who reached Razorpay from the register form and didn't
 *    pay. Reminder 1 about 2 hours after they left, then every 3 days; at
 *    most 3 ever (the Abandoned tab's manual emails count). Email (MSG91
 *    template) and WhatsApp (approved "registration_link_noref").
 *  - verify: members who paid but never verified (email + WhatsApp OTP), so
 *    they can't save their profile. 1, 4 and 7 days after joining; email from
 *    the support mailbox, so a reply with their mobile is verified by the
 *    support agent.
 * Never between 9 pm and 8 am IST, never twice in 3 days, stops when they pay
 * / verify / opt out. Old records are included and worked through gradually.
 */

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const REMINDER_LIMIT = 3;
export const REMINDER_GAP_MS = 3 * DAY;
export const FIRST_UNPAID_AFTER_MS = 2 * HOUR;
export const FIRST_VERIFY_AFTER_MS = DAY;
/** Sends per run (a run every 15 minutes) and per day, so a backlog goes out gradually. */
export const PER_RUN = 8;
export const PER_DAY = 150;
const SITE = () => (process.env.SITE_URL || "https://www.seetharamakalyana.in").replace(/\/+$/, "");
const API = () => (process.env.PUBLIC_API_URL || "https://api.seetharamakalyana.in/api").replace(/\/+$/, "");

/** One record per reminder sent (or tried), for counting and the daily summary. */
const ReminderSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["unpaid", "verify"], required: true },
    refId: { type: String, required: true, index: true },
    n: Number,
    email: Boolean,
    whatsapp: Boolean,
    error: String,
  },
  { timestamps: true, versionKey: false }
);
export const OpsReminder = mongoose.models.OpsReminder || mongoose.model("OpsReminder", ReminderSchema);

/** IST hour as a fraction; reminders go out 8 am to 9 pm only. */
const istHour = (now) => {
  const d = new Date(now + 5.5 * HOUR);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};
export const quietHours = (now = Date.now()) => istHour(now) < 8 || istHour(now) >= 21;

/** The "don't remind me" link: signed, so nobody can stop someone else's reminders. */
const secret = () => process.env.INTERNAL_ROUTE_SECRET || process.env.JWT_SECRET || "reminders";
export const stopSig = (kind, id) => crypto.createHmac("sha256", secret()).update(`${kind}:${id}`).digest("hex").slice(0, 24);
export const stopLink = (kind, id) => `${API()}/reminders/stop?k=${kind}&id=${id}&s=${stopSig(kind, id)}`;

/** Marks someone as not wanting reminders. Returns true when the link was valid. */
export const stopReminders = async (kind, id, sig) => {
  if (!["unpaid", "verify"].includes(kind) || !mongoose.isValidObjectId(id)) return false;
  const a = Buffer.from(String(sig || ""));
  const b = Buffer.from(stopSig(kind, id));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (kind === "unpaid") await AbandonedCheckout.updateOne({ _id: id }, { $set: { remindersOff: true } });
  else await User.updateOne({ _id: id }, { $set: { "reminders.off": true } });
  return true;
};

const first = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

const verifyMail = (user, n) => ({
  subject: n === 1 ? "One last step: verify your profile" : "Your profile is still waiting to be verified",
  text: `Dear ${first(user.basic?.fullName)},

Thank you for joining Seetha Rama Kalyana. Your profile isn't verified yet, so you can't save it and families can't see it fully.

To verify, log in at ${SITE()}/profile and confirm the codes we send to your email and WhatsApp.

Didn't get the WhatsApp code? Just reply to this email with your registered mobile number, and we'll verify your profile for you.

Warm regards,
Team Seetha Rama Kalyana

Don't want these reminders? ${stopLink("verify", user._id)}`,
});

/** People who left at Razorpay and are due a reminder now, oldest first. */
const dueUnpaid = (now, limit) =>
  AbandonedCheckout.find({
    convertedAt: null,
    status: { $ne: "paid" },
    remindersOff: { $ne: true },
    emailCount: { $not: { $gte: REMINDER_LIMIT } },
    lastAttemptAt: { $lte: new Date(now - FIRST_UNPAID_AFTER_MS) },
    $or: [{ lastEmailedAt: null }, { lastEmailedAt: { $lte: new Date(now - REMINDER_GAP_MS) } }],
  })
    .sort({ lastAttemptAt: 1 })
    .limit(limit);

/** Members who paid but never verified, due a reminder now, oldest first. */
const dueVerify = (now, limit) =>
  User.find({
    isVerified: { $ne: true },
    isAdmin: { $ne: true },
    "reminders.off": { $ne: true },
    "reminders.verifyCount": { $not: { $gte: REMINDER_LIMIT } },
    createdAt: { $lte: new Date(now - FIRST_VERIFY_AFTER_MS) },
    $or: [{ "reminders.verifyLastAt": null }, { "reminders.verifyLastAt": { $lte: new Date(now - REMINDER_GAP_MS) } }],
  })
    .select("basic.fullName basic.email basic.mobile reminders createdAt")
    .sort({ createdAt: 1 })
    .limit(limit);

const remindUnpaid = async (row, now) => {
  // Claimed first, so two runs can never send the same reminder twice.
  const claimed = await AbandonedCheckout.findOneAndUpdate(
    { _id: row._id, emailCount: row.emailCount ?? 0, convertedAt: null },
    { $inc: { emailCount: 1 }, $set: { lastEmailedAt: new Date(now) } },
    { new: true }
  );
  if (!claimed) return null;
  // Someone who joined in the meantime never gets one.
  if (await User.exists({ $or: [{ "basic.email": row.email }, ...(row.mobile ? [{ "basic.mobile": row.mobile }] : [])] })) {
    await AbandonedCheckout.updateOne({ _id: row._id }, { $inc: { emailCount: -1 }, $set: { lastEmailedAt: row.lastEmailedAt ?? null } });
    return null;
  }
  const n = claimed.emailCount;
  const result = { kind: "unpaid", refId: String(row._id), n, email: false, whatsapp: false };
  const errors = [];
  try {
    const response = await sendEmail({ to: [{ email: row.email, name: row.name }], template_id: "complete_registration_en", variables: { name: row.name } });
    result.email = true;
    await AbandonedCheckout.updateOne({ _id: row._id }, { $push: { emails: { at: new Date(now), byName: "Ops agent (automatic reminder)", ok: true, response } } });
  } catch (err) {
    errors.push(`email: ${err?.response?.data?.message || err.message}`);
    await AbandonedCheckout.updateOne({ _id: row._id }, { $push: { emails: { at: new Date(now), byName: "Ops agent (automatic reminder)", ok: false, response: String(err.message).slice(0, 200) } } });
  }
  if (row.mobile && whatsappConfigured()) {
    try {
      await sendWhatsappTemplate({
        to: row.mobile,
        name: "registration_link_noref",
        language: "en",
        components: { header_1: { filename: "logo.png", type: "image", value: `${SITE()}/logo.png` } },
      });
      result.whatsapp = true;
    } catch (err) {
      errors.push(`whatsapp: ${err.message}`);
    }
  }
  if (!result.email && !result.whatsapp) {
    // Nothing reached them: this one doesn't count towards their 3.
    await AbandonedCheckout.updateOne({ _id: row._id }, { $inc: { emailCount: -1 }, $set: { lastEmailedAt: row.lastEmailedAt ?? null } });
  }
  if (errors.length) result.error = errors.join("; ").slice(0, 300);
  return result;
};

const remindVerify = async (user, now) => {
  const count = user.reminders?.verifyCount ?? 0;
  const claimed = await User.findOneAndUpdate(
    { _id: user._id, isVerified: { $ne: true }, "reminders.verifyCount": count ? count : { $in: [null, 0] } },
    { $set: { "reminders.verifyCount": count + 1, "reminders.verifyLastAt": new Date(now) } },
    { new: true }
  );
  if (!claimed) return null;
  const n = count + 1;
  const result = { kind: "verify", refId: String(user._id), n, email: false, whatsapp: false };
  try {
    await sendMail({ to: user.basic.email, ...verifyMail(user, n), inReplyTo: undefined });
    result.email = true;
  } catch (err) {
    result.error = `email: ${err.message}`.slice(0, 300);
    await User.updateOne({ _id: user._id }, { $set: { "reminders.verifyCount": count, "reminders.verifyLastAt": user.reminders?.verifyLastAt ?? null } });
  }
  return result;
};

/**
 * One run: sends the reminders that are due, up to PER_RUN (and PER_DAY in
 * 24 h). Throws only when every send of the run failed, so a broken mail or
 * MSG91 setup shows as a failing job (owner alerted on WhatsApp).
 */
export const runReminders = async ({ now = Date.now() } = {}) => {
  if (quietHours(now)) return { skipped: "quiet hours (9 pm – 8 am IST)" };
  const sentToday = await OpsReminder.countDocuments({ createdAt: { $gte: new Date(now - DAY) }, $or: [{ email: true }, { whatsapp: true }] });
  const room = Math.min(PER_RUN, PER_DAY - sentToday);
  if (room <= 0) return { skipped: `daily limit of ${PER_DAY} reached` };
  await syncConversions().catch(() => {});

  const half = Math.ceil(room / 2);
  const verifyRows = mailConfigured() ? await dueVerify(now, half) : [];
  const unpaidRows = await dueUnpaid(now, room - verifyRows.length);
  const results = [];
  for (const u of verifyRows) {
    const r = await remindVerify(u, now);
    if (r) results.push(r);
  }
  for (const row of unpaidRows) {
    const r = await remindUnpaid(row, now);
    if (r) results.push(r);
  }
  if (results.length) await OpsReminder.insertMany(results);
  const reached = results.filter((r) => r.email || r.whatsapp);
  if (results.length >= 2 && !reached.length) throw new Error(`No reminder could be sent: ${results[0].error ?? "unknown error"}`);
  await dailySummary(now).catch(() => {});
  return {
    unpaid: results.filter((r) => r.kind === "unpaid" && (r.email || r.whatsapp)).length,
    verify: results.filter((r) => r.kind === "verify" && r.email).length,
    failed: results.length - reached.length,
  };
};

/** One line in Activity each evening: today's reminders and what came of them. */
const dailySummary = async (now) => {
  if (istHour(now) < 20.5) return;
  const since = new Date(now - DAY);
  const [unpaid, verify, paidAfter, verifiedAfter] = await Promise.all([
    OpsReminder.countDocuments({ kind: "unpaid", createdAt: { $gte: since }, $or: [{ email: true }, { whatsapp: true }] }),
    OpsReminder.countDocuments({ kind: "verify", createdAt: { $gte: since }, email: true }),
    AbandonedCheckout.countDocuments({ convertedAfterEmail: true, convertedAt: { $gte: since } }),
    User.countDocuments({ isVerified: true, "reminders.verifyCount": { $gte: 1 }, updatedAt: { $gte: since } }),
  ]);
  if (!unpaid && !verify) return;
  const date = new Date(now + 5.5 * HOUR).toISOString().slice(0, 10);
  await notice("support", {
    type: "support.reminders",
    priority: "low",
    title: `Reminders today: ${unpaid} to unpaid sign-ups, ${verify} to unverified members`,
    reason: `In the last 24 hours ${paidAfter} paid after a reminder and ${verifiedAfter} reminded member(s) got verified. At most ${REMINDER_LIMIT} reminders per person, 3 days apart.`,
    payload: { dedupeKey: `reminders:${date}` },
  });
};

