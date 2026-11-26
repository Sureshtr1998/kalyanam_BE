import Settings from "../models/Settings.js";
import User from "../models/User.js";
import { notify } from "../config/msg91Email.js";

const SETTINGS_ID = "global";

/** How long after a member's first help request auto-verify mode verifies them. */
export const AUTO_VERIFY_DELAY_MS = 4 * 60 * 60 * 1000;
export const AUTO_VERIFY_DELAY = "14400s"; // QStash delay, same 4 hours

export const getAutoVerifySettings = async () => {
  const s = await Settings.findById(SETTINGS_ID).lean();
  return {
    enabled: !!s?.autoVerifyHelp,
    updatedBy: s?.autoVerifyUpdatedBy ?? null,
    updatedAt: s?.autoVerifyUpdatedAt ?? null,
  };
};

export const setAutoVerify = (enabled, updatedBy) =>
  Settings.findByIdAndUpdate(
    SETTINGS_ID,
    { autoVerifyHelp: !!enabled, autoVerifyUpdatedBy: updatedBy, autoVerifyUpdatedAt: new Date() },
    { upsert: true }
  );

/**
 * Verifies one member if auto-verify mode is on, they asked for help at least 4 hours ago,
 * and they're still unverified. The email and number they asked about become their contact
 * details, unless another member already uses them. Returns true when it verified them.
 * @param {import("mongoose").HydratedDocument<any>} user
 * @param {{ enabled?: boolean, now?: number }} [opts]
 */
export const autoVerifyIfDue = async (user, opts = {}) => {
  const help = user?.verifyHelp;
  if (!user || user.isVerified || !help?.at) return false;
  const now = opts.now ?? Date.now();
  if (now - new Date(help.at).getTime() < AUTO_VERIFY_DELAY_MS) return false;
  const enabled = opts.enabled ?? (await getAutoVerifySettings()).enabled;
  if (!enabled) return false;

  if (help.email && !(await User.exists({ "basic.email": help.email, _id: { $ne: user._id } }))) {
    user.basic.email = help.email;
  }
  if (help.mobile && !(await User.exists({ "basic.mobile": help.mobile, _id: { $ne: user._id } }))) {
    user.basic.mobile = help.mobile;
  }
  user.isVerified = true;
  user.autoVerifiedAt = new Date(now);
  user.verifyHelp = undefined;
  await user.save();
  notify({
    to: [{ email: user.basic.email }],
    template_id: "profile_verified_3", // same MSG91 template as the admin's Verified toggle
    variables: { userName: user.basic.fullName, email: user.basic.email, mobile: user.basic.mobile },
  });
  return true;
};

/** Verifies every member whose 4 hours are up. A no-op while the mode is off. Returns how many. */
export const autoVerifyDue = async (now = Date.now()) => {
  const { enabled } = await getAutoVerifySettings();
  if (!enabled) return 0;
  const due = await User.find({
    isVerified: { $ne: true },
    "verifyHelp.at": { $lte: new Date(now - AUTO_VERIFY_DELAY_MS) },
  }).limit(200);
  let count = 0;
  for (const user of due) if (await autoVerifyIfDue(user, { enabled, now })) count++;
  return count;
};
