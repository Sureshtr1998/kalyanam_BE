import User from "../models/User.js";
import { OpsAction, getConfig } from "./models.js";
import { mailConfigured, sendMail } from "./mail.js";

/*
 * Urgent alerts by email, so the owner hears about them without opening the
 * panel: Meta account problems, disapproved ads, stalled delivery,
 * vendor warnings. Sent from the support mailbox to the alert address in
 * Ops → Settings (blank = every admin's account email). Each alert is sent
 * once; the feed dedupes repeats for 24 hours.
 */

export const ALERT_SUBJECT = "[SRK Ops]";
const SITE = () => (process.env.SITE_URL || "https://www.seetharamakalyana.in").replace(/\/+$/, "");

const recipients = async () => {
  const config = await getConfig();
  const set = String(config.ads?.alertEmail || "").trim();
  if (set) return set;
  const admins = await User.find({ isAdmin: true }).select("basic.email").lean();
  return admins.map((a) => a.basic?.email).filter(Boolean).join(",");
};

/** Emails one urgent action to the owner. Never throws. */
export const alertOwner = async (action) => {
  try {
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
  } catch (err) {
    console.error("[ops] alert mail", err.message);
    return false;
  }
};
