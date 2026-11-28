import User from "../models/User.js";
import { OpsAction, OpsConfig, getConfig } from "./models.js";
import { mailConfigured, sendMail } from "./mail.js";
import { normalizeWhatsapp, sendWhatsappAlert, whatsappConfigured } from "./whatsapp.js";

/*
 * Urgent alerts reach the owner without opening the panel:
 *  - by email (support mailbox → the alert address in Ops → Settings, blank =
 *    every admin's account email), and
 *  - by WhatsApp to the owner's own phone (Ops → Settings → WhatsApp alerts),
 *    the channel the owner actually watches.
 * Urgent = failures and breakages, members writing again and again for
 * something only the owner can do, safety/legal/payment-dispute mails,
 * Meta account problems. Prepaid funds (Meta, MSG91) are the owner's to
 * watch: they never go to WhatsApp.
 */

export const ALERT_SUBJECT = "[SRK Ops]";
const SITE = () => (process.env.SITE_URL || "https://www.seetharamakalyana.in").replace(/\/+$/, "");
const HOUR = 3600000;
/** The same thing isn't sent to WhatsApp twice within this window. */
const WHATSAPP_REPEAT_MS = 12 * HOUR;
/** A flood (something looping) stops at this many WhatsApps a day; email still goes. */
export const WHATSAPP_PER_DAY = 20;
/**
 * Low-balance alerts the owner watches on their own (no WhatsApp). MSG91 is not
 * one: its alerts fire only when auto-recharge failed or sends are refused,
 * and go to WhatsApp at once (owner, 28 Nov 2026).
 */
const FUNDS_TYPES = new Set(["ads.funds_low"]);

const recipients = async () => {
  const config = await getConfig();
  const set = String(config.ads?.alertEmail || "").trim();
  if (set) return set;
  const admins = await User.find({ isAdmin: true }).select("basic.email").lean();
  return admins.map((a) => a.basic?.email).filter(Boolean).join(",");
};

/** Whether this action goes to the owner's WhatsApp. */
export const wantsWhatsapp = (action) =>
  (action.priority === "urgent" || action.payload?.whatsapp === true) && action.payload?.whatsapp !== false && !FUNDS_TYPES.has(action.type);

/** Repeats of one thing share a key: one member's mails, one failing job, one kind of failure. */
export const whatsappKey = (action) =>
  action.payload?.whatsappKey ??
  (action.payload?.to ? `${action.module}:${String(action.payload.to).toLowerCase()}` : null) ??
  action.payload?.dedupeKey ??
  `${action.type}:${action.ref?.id ?? action.title}`;

const emailOwner = async (action) => {
  if (!mailConfigured()) return false;
  const to = await recipients();
  if (!to) return false;
  await sendMail({
    to,
    subject: `${ALERT_SUBJECT} ${action.title}`.slice(0, 180),
    text: [action.title, "", action.reason, "", action.effect, "", `Open the Ops tab: ${SITE()}/admin?tab=ops`].filter((l) => l != null).join("\n"),
    inReplyTo: undefined,
  });
  await OpsAction.updateOne({ _id: action._id }, { $set: { "payload.alertedAt": new Date() } });
  return true;
};

/** Sends one action to the owner's WhatsApp, unless it was just sent or today's cap is reached. */
export const whatsappOwner = async (action) => {
  if (!wantsWhatsapp(action) || !whatsappConfigured()) return false;
  const config = await getConfig();
  const to = normalizeWhatsapp(config.alerts?.whatsapp);
  if (!to) return false;
  const key = whatsappKey(action);
  const now = Date.now();
  const [recent, today] = await Promise.all([
    OpsAction.exists({ _id: { $ne: action._id }, "payload.whatsappKey": key, "payload.whatsappAt": { $gte: new Date(now - WHATSAPP_REPEAT_MS) } }),
    OpsAction.countDocuments({ "payload.whatsappAt": { $gte: new Date(now - 24 * HOUR) } }),
  ]);
  if (recent) return false;
  if (today >= WHATSAPP_PER_DAY) {
    await OpsAction.updateOne({ _id: action._id }, { $set: { "payload.whatsappSkipped": `over ${WHATSAPP_PER_DAY} WhatsApps today` } });
    return false;
  }
  try {
    const from = action.module === "support" && action.payload?.to ? `From ${action.payload.to}.` : "";
    await sendWhatsappAlert({ to, title: action.title, detail: [action.reason, from, action.effect].filter(Boolean).join(" ") });
    await Promise.all([
      OpsAction.updateOne({ _id: action._id }, { $set: { "payload.whatsappAt": new Date(), "payload.whatsappKey": key } }),
      OpsConfig.updateOne({ _id: "ops" }, { $set: { "alerts.lastSentAt": new Date(), "alerts.lastError": "" } }),
    ]);
    return true;
  } catch (err) {
    const message = String(err?.response?.data?.message || err?.message || err).slice(0, 300);
    console.error("[ops] alert WhatsApp", message);
    await Promise.all([
      OpsAction.updateOne({ _id: action._id }, { $set: { "payload.whatsappError": message } }),
      OpsConfig.updateOne({ _id: "ops" }, { $set: { "alerts.lastError": message, "alerts.lastErrorAt": new Date() } }),
    ]).catch(() => {});
    return false;
  }
};

/** Emails one urgent action to the owner and sends it to their WhatsApp. Never throws. */
export const alertOwner = async (action) => {
  const [mailed, whatsapped] = await Promise.all([
    emailOwner(action).catch((err) => {
      console.error("[ops] alert mail", err.message);
      return false;
    }),
    whatsappOwner(action).catch((err) => {
      console.error("[ops] alert WhatsApp", err.message);
      return false;
    }),
  ]);
  return mailed || whatsapped;
};
