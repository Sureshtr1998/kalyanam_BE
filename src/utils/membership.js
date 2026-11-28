import mongoose from "mongoose";
import User from "../models/User.js";
import DeletedMember from "../models/DeletedMember.js";
import { notify } from "../config/msg91Email.js";
import { sendWhatsappTemplate, templateText, whatsappConfigured } from "../ops/whatsapp.js";
import { removeMember } from "./removeMember.js";
import { acceptsViewerQuery } from "./matching.js";

/*
 * One-year memberships, starting March 2027.
 *
 *   active   ─ until 30 days before the end date
 *   renewal  ─ last 30 days: banner + reminders, everything still works
 *   grace    ─ 0-15 days after the end: still visible, can answer interests
 *              already received, but can't send new ones or open contacts
 *   paused   ─ 15+ days after the end: hidden from everyone (isPaused) until
 *              renewed; can log in, sees a renew screen
 *   closed   ─ "Marriage fixed": hidden, no reminders, reopen any time
 *
 * Nothing is deleted on expiry. Only an account paused for 2 years with no
 * visit in 2 years is deleted, after a 30-day and a 48-hour warning; its
 * payment records are kept in DeletedMember for tax.
 *
 * The first paid year starts at the launch: everyone who joined before it
 * ends on 29 Feb 2028 (one year from 1 March 2027); later members get one
 * year from the day they joined.
 *
 * Inactive profiles are never hidden (owner, 28 Nov 2026; the 90-day rule was
 * removed the day it started): members see who is active through the "active
 * within" filter and sort, and the yearly membership pauses those who don't renew.
 */

const DAY = 24 * 60 * 60 * 1000;

/** 1 March 2027, 00:00 IST: banners, renewals and limits switch on. */
export const MEMBERSHIP_LAUNCH = new Date("2027-02-28T18:30:00.000Z");
/** 29 Feb 2028, end of day IST: one year from the launch, the end date for everyone who joined before it. */
export const LEGACY_END = new Date("2028-02-29T18:29:59.999Z");

export const RENEWAL_WINDOW_DAYS = 30;
export const GRACE_DAYS = 15;
export const DORMANT_DAYS = 730;
const FINAL_WARNING_AFTER_DAYS = 28;
const DELETE_AFTER_FINAL_HOURS = 48;

export const addYear = (date) => {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
};

const joinedAt = (user) =>
  user.createdAt ?? (user._id instanceof mongoose.Types.ObjectId ? user._id.getTimestamp() : new Date());

/** End date for a member who has never renewed. */
export const firstEndDate = (joined) => {
  const year = addYear(joined);
  return year > LEGACY_END ? year : new Date(LEGACY_END);
};

export const endDateOf = (user) => user.membershipEndsAt ?? firstEndDate(joinedAt(user));

export const isLaunched = (now = new Date()) => now >= MEMBERSHIP_LAUNCH;

/** "active" | "renewal" | "grace" | "paused" | "closed" */
export const membershipStage = (user, now = new Date()) => {
  if (user.marriedAt) return "closed";
  const end = endDateOf(user).getTime();
  const t = now.getTime();
  if (t < end - RENEWAL_WINDOW_DAYS * DAY) return "active";
  if (t <= end) return "renewal";
  if (t <= end + GRACE_DAYS * DAY) return "grace";
  return "paused";
};

/** Renewal is offered from 30 days before the end date onward (after the launch). */
export const canRenew = (user, now = new Date()) =>
  isLaunched(now) && ["renewal", "grace", "paused"].includes(membershipStage(user, now));

const BLOCKED_MSG = {
  grace: "Your membership has ended. Renew to send interests and view contacts. You can still reply to interests you received.",
  paused: "Your membership has ended and your profile is hidden. Renew to show it again and continue.",
  closed: "You closed your profile after fixing your marriage. Reopen it from Account to continue.",
};

/**
 * Why `user` can't do something that needs a live membership (sending
 * interests, opening contacts, browsing matches), or null if they can.
 * Nothing is limited before the launch.
 */
export const membershipBlock = (user, now = new Date()) => {
  if (user.isAdmin) return null;
  const stage = membershipStage(user, now);
  if (stage === "closed") return BLOCKED_MSG.closed;
  if (!isLaunched(now)) return null;
  return BLOCKED_MSG[stage] ?? null;
};

/** Browsing matches stays open in grace; only paused and closed members are stopped. */
export const browseBlock = (user, now = new Date()) =>
  membershipStage(user, now) === "grace" ? null : membershipBlock(user, now);

/** For sending a 403 the app can recognise. */
export const membershipError = (msg) => ({ msg, code: "MEMBERSHIP_REQUIRED" });

/** Mongo condition: profiles other members may see. Combine with isHidden: false. */
export const VISIBLE = { isPaused: { $ne: true }, marriedAt: null };

/** What GET /membership returns to the member. */
export const membershipSummary = async (user, now = new Date()) => {
  const stage = membershipStage(user, now);
  const endsAt = endDateOf(user);
  const summary = {
    launched: isLaunched(now),
    launchAt: MEMBERSHIP_LAUNCH,
    stage,
    endsAt,
    daysLeft: Math.ceil((endsAt.getTime() - now.getTime()) / DAY),
    canRenew: canRenew(user, now),
    isPaused: !!user.isPaused,
    marriedAt: user.marriedAt ?? null,
    graceEndsAt: new Date(endsAt.getTime() + GRACE_DAYS * DAY),
  };
  if (!summary.launched || !["grace", "paused"].includes(stage)) return summary;

  // Real numbers only: members who joined since the end date and would see
  // this member, and interests still waiting for an answer.
  const answered = new Set(
    [...(user.interests?.accepted ?? []), ...(user.interests?.declined ?? [])].map(String)
  );
  const pendingInterests = (user.interests?.received ?? []).filter((id) => !answered.has(String(id))).length;
  const gender = String(user.basic?.gender || "").toLowerCase() === "male" ? "female" : "male";
  const and = acceptsViewerQuery(user);
  const newMatches = await User.countDocuments({
    "basic.gender": { $regex: `^${gender}$`, $options: "i" },
    isHidden: false,
    isCorrupted: { $ne: true },
    hasCompleteProfile: true,
    ...VISIBLE,
    createdAt: { $gt: endsAt },
    hideProfiles: { $ne: user._id },
    ...(and.length ? { $and: and } : {}),
  });
  return { ...summary, newMatches, pendingInterests };
};

/**
 * Adds a year to the membership: from the current end date if it hasn't
 * passed yet (early renewers lose nothing), otherwise from now. Unpauses and
 * adds the renewal interests. Applying the same orderId twice is a no-op.
 * Returns the new end date, or null if this order was already applied.
 */
export const applyRenewal = async (userId, { orderId, paymentId, amountPaid, interests, note }, now = new Date()) => {
  const transaction = {
    orderId,
    paymentId,
    amountPaid,
    noOfInterest: interests,
    note: note || "Membership renewal",
    dateOfTrans: now,
  };
  const res = await User.updateOne(
    { _id: userId, "transactions.orderId": { $ne: orderId } },
    [
      {
        $set: {
          membershipEndsAt: {
            $dateAdd: {
              startDate: {
                $max: [
                  now,
                  {
                    $ifNull: [
                      "$membershipEndsAt",
                      {
                        $max: [
                          LEGACY_END,
                          { $dateAdd: { startDate: { $ifNull: ["$createdAt", { $toDate: "$_id" }] }, unit: "year", amount: 1 } },
                        ],
                      },
                    ],
                  },
                ],
              },
              unit: "year",
              amount: 1,
            },
          },
          isPaused: false,
          "interests.totalNoOfInterest": { $add: [{ $ifNull: ["$interests.totalNoOfInterest", 0] }, interests || 0] },
          transactions: { $concatArrays: [[{ $literal: transaction }], { $ifNull: ["$transactions", []] }] },
        },
      },
      { $unset: ["dormantWarnedAt", "dormantFinalWarnedAt"] },
    ]
  );
  if (!res.modifiedCount) return null;
  const fresh = await User.findById(userId).select("membershipEndsAt").lean();
  return fresh?.membershipEndsAt ?? null;
};

// --- Daily job --------------------------------------------------------------

const istDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const siteUrl = () => String(process.env.FRONTEND_URL || "https://seetharamakalyana.in").replace(/\/$/, "");

/*
 * Reminder stages. WhatsApp and email templates must exist (and the WhatsApp
 * ones be approved) in MSG91 under these names; a missing template only
 * makes that send fail, the stage is still recorded so nobody is spammed.
 * Values: {{1}} name, {{2}} end date, {{3}} link (WhatsApp, in this order).
 */
export const REMINDERS = {
  d30: { whatsapp: "membership_ending_30d", email: "membership_ending_30d" },
  d7: { whatsapp: "membership_ending_7d", email: null },
  d1: { whatsapp: "membership_ending_1d", email: null },
  d0: { whatsapp: null, email: "membership_ended" },
  p15: { whatsapp: "membership_paused", email: null },
  p60: { whatsapp: null, email: "membership_winback" },
  dormant30: { whatsapp: "account_deletion_notice", email: "account_deletion_notice" },
  dormant2: { whatsapp: "account_deletion_final", email: "account_deletion_notice" },
};

/** The reminder due now for this end date, or null. Only the most urgent one, never a burst. */
export const reminderDue = (endsAt, now = new Date()) => {
  const diff = endsAt.getTime() - now.getTime();
  if (diff > 0) {
    const daysLeft = Math.ceil(diff / DAY);
    if (daysLeft <= 1) return "d1";
    if (daysLeft <= 7) return "d7";
    if (daysLeft <= RENEWAL_WINDOW_DAYS) return "d30";
    return null;
  }
  const daysSince = Math.floor(-diff / DAY);
  if (daysSince < GRACE_DAYS) return "d0";
  if (daysSince < 45) return "p15";
  if (daysSince >= 60 && daysSince < 90) return "p60";
  return null;
};

const ORDER = ["d30", "d7", "d1", "d0", "p15", "p60"];

const sendReminder = async (user, key, endsAt) => {
  const tpl = REMINDERS[key];
  const name = user.basic?.fullName || "";
  const date = istDate(endsAt);
  const link = `${siteUrl()}/account`;
  let whatsapp;
  if (tpl.whatsapp && whatsappConfigured()) {
    try {
      await sendWhatsappTemplate({
        to: user.basic?.mobile,
        name: tpl.whatsapp,
        language: "en",
        components: Object.fromEntries(
          [name, date, link].map((v, i) => [`body_${i + 1}`, { type: "text", value: templateText(v, 200) }])
        ),
      });
      whatsapp = true;
    } catch (err) {
      console.error(`[membership] WhatsApp ${tpl.whatsapp}:`, err.message);
      whatsapp = false;
    }
  }
  let email;
  if (tpl.email && user.basic?.email) {
    email = true;
    await notify({
      to: [{ email: user.basic.email, name }],
      template_id: tpl.email,
      variables: { user_name: name, end_date: date, renew_link: link },
    });
  }
  return { whatsapp, email };
};

/** Fills membershipEndsAt for members who don't have one yet. */
const backfillEndDates = async () => {
  const res = await User.updateMany({ membershipEndsAt: null }, [
    {
      $set: {
        membershipEndsAt: {
          $max: [
            LEGACY_END,
            { $dateAdd: { startDate: { $ifNull: ["$createdAt", { $toDate: "$_id" }] }, unit: "year", amount: 1 } },
          ],
        },
      },
    },
  ]);
  return res.modifiedCount;
};

const lastSeenBefore = (cutoff) => ({
  $or: [{ lastActiveAt: { $lt: cutoff } }, { lastActiveAt: null, createdAt: { $lt: cutoff } }],
});

/**
 * Shows again every profile the removed 90-day rule hid (it ran once, on
 * 28 Nov 2026, and counted members with no recorded visit from the day they
 * joined, because visits were only recorded from 31 Oct 2026). Returns how many.
 */
export const showInactivityHidden = async () => {
  const res = await User.updateMany(
    { hiddenForInactivityAt: { $ne: null }, marriedAt: null },
    { $set: { isHidden: false }, $unset: { hiddenForInactivityAt: 1 } }
  );
  return res.modifiedCount;
};

/** Moves dormant accounts through 30-day warning → 48-hour warning → deletion. */
const runDormantCleanup = async (now, deadline) => {
  const out = { warned: 0, finalWarned: 0, deleted: 0, cleared: 0 };

  // Came back after a warning: start over.
  const back = await User.updateMany(
    { dormantWarnedAt: { $ne: null }, $expr: { $gt: ["$lastActiveAt", "$dormantWarnedAt"] } },
    { $unset: { dormantWarnedAt: 1, dormantFinalWarnedAt: 1 } }
  );
  out.cleared = back.modifiedCount;

  const cutoff = new Date(now.getTime() - DORMANT_DAYS * DAY);
  const candidates = await User.find({
    isPaused: true,
    isAdmin: { $ne: true },
    membershipEndsAt: { $lt: cutoff },
    ...lastSeenBefore(cutoff),
  }).limit(50);

  for (const user of candidates) {
    if (Date.now() > deadline) break;
    if (!user.dormantWarnedAt) {
      await sendReminder(user, "dormant30", user.membershipEndsAt);
      await User.updateOne({ _id: user._id }, { dormantWarnedAt: now });
      out.warned++;
    } else if (!user.dormantFinalWarnedAt) {
      if (now.getTime() - user.dormantWarnedAt.getTime() < FINAL_WARNING_AFTER_DAYS * DAY) continue;
      await sendReminder(user, "dormant2", user.membershipEndsAt);
      await User.updateOne({ _id: user._id }, { dormantFinalWarnedAt: now });
      out.finalWarned++;
    } else if (now.getTime() - user.dormantFinalWarnedAt.getTime() >= DELETE_AFTER_FINAL_HOURS * 3600 * 1000) {
      await DeletedMember.create({
        memberId: user._id,
        uniqueId: user.basic?.uniqueId,
        joinedAt: user.createdAt,
        membershipEndsAt: user.membershipEndsAt,
        reason: "dormant",
        transactions: user.transactions,
      });
      await removeMember(user);
      out.deleted++;
    }
  }
  return out;
};

/**
 * The daily membership job (Ops tick "membership"). Safe to run any number of
 * times a day: every step checks what was already done.
 */
export const runMembershipCycle = async ({ now = new Date(), budgetMs = 40000 } = {}) => {
  const deadline = Date.now() + budgetMs;
  const out = { backfilled: 0, paused: 0, reminders: {}, dormant: null };

  out.backfilled = await backfillEndDates();

  if (!isLaunched(now)) return out;

  const paused = await User.updateMany(
    {
      isPaused: { $ne: true },
      isAdmin: { $ne: true },
      marriedAt: null,
      membershipEndsAt: { $lt: new Date(now.getTime() - GRACE_DAYS * DAY) },
    },
    { $set: { isPaused: true } }
  );
  out.paused = paused.modifiedCount;

  // Reminders: everyone whose end date is between 90 days ago and 30 days ahead.
  const cursor = User.find({
    marriedAt: null,
    isCorrupted: { $ne: true },
    isAdmin: { $ne: true },
    membershipEndsAt: {
      $gt: new Date(now.getTime() - 90 * DAY),
      $lte: new Date(now.getTime() + RENEWAL_WINDOW_DAYS * DAY),
    },
  })
    .select("basic.fullName basic.email basic.mobile membershipEndsAt membershipReminders")
    .cursor();

  for await (const user of cursor) {
    if (Date.now() > deadline) break;
    const endsAt = user.membershipEndsAt;
    const key = reminderDue(endsAt, now);
    if (!key) continue;
    const sent = (user.membershipReminders ?? []).filter((r) => r.endsAt?.getTime() === endsAt.getTime());
    // Already sent this one, or a later one (e.g. renewed and then the date moved back).
    if (sent.some((r) => ORDER.indexOf(r.key) >= ORDER.indexOf(key))) continue;
    const result = await sendReminder(user, key, endsAt);
    await User.updateOne(
      { _id: user._id },
      { $push: { membershipReminders: { $each: [{ key, endsAt, at: now, ...result }], $slice: -30 } } }
    );
    out.reminders[key] = (out.reminders[key] ?? 0) + 1;
  }

  if (Date.now() < deadline) out.dormant = await runDormantCleanup(now, deadline);
  return out;
};
