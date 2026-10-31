import { Router } from "express";
import mongoose from "mongoose";
import { auth } from "../../middleware/auth.js";
import User from "../../models/User.js";
import dbConnect from "../../utils/dbConnect.js";
import { notify } from "../../config/msg91Email.js";
import { SUPPORT_EMAIL } from "../../utils/constants.js";
import { canView, publicProjection } from "../../utils/matching.js";

const router = Router();
const MAX_VIEWS = 100;

const hasId = (list = [], id) => list.some((x) => String(x) === String(id));

// hideProfiles is loaded so canView can check blocks both ways; strip it with toPublic.
const listProjection = publicProjection.replace(" -hideProfiles", "");
const toPublic = ({ hideProfiles, ...profile }) => profile;

/** Loads profiles by id, keeping the given order and dropping deleted ones. */
const loadOrdered = async (ids) => {
  const users = await User.find({ _id: { $in: ids } }, listProjection).lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
};

/** Toggle a profile in the member's shortlist. */
router.post("/shortlist", auth, async (req, res) => {
  try {
    await dbConnect();
    const { userId } = req.body || {};
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ msg: "Invalid profile" });
    }
    // @ts-ignore
    const me = req.user;
    const saved = hasId(me.shortlisted, userId);
    await User.updateOne(
      { _id: me._id },
      saved
        ? { $pull: { shortlisted: new mongoose.Types.ObjectId(String(userId)) } }
        : { $push: { shortlisted: { $each: [new mongoose.Types.ObjectId(String(userId))], $position: 0 } } }
    );
    const fresh = await User.findById(me._id).select("shortlisted").lean();
    return res.json({
      shortlisted: fresh?.shortlisted ?? [],
      saved: !saved,
      msg: saved ? "Removed from shortlist" : "Added to shortlist",
    });
  } catch (err) {
    console.error("Shortlist error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

router.get("/shortlist", auth, async (req, res) => {
  try {
    await dbConnect();
    // @ts-ignore
    const me = req.user;
    const profiles = await loadOrdered(me.shortlisted || []);
    // Someone may have blocked me or changed preferences since I saved them.
    const visible = profiles.filter((p) => canView(me, p)).map(toPublic);
    return res.json({ activities: visible, count: visible.length });
  } catch (err) {
    console.error("Shortlist fetch error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/** Records that the current member opened someone's profile. */
router.post("/profile-view", auth, async (req, res) => {
  try {
    await dbConnect();
    const { userId } = req.body || {};
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ msg: "Invalid profile" });
    }
    // @ts-ignore
    const me = req.user;
    const target = await User.findById(userId).select("basic.gender partner hideProfiles isHidden");
    // Only record views of profiles the member could actually open.
    if (!target || !canView(me, target)) return res.json({ ok: true });

    await User.updateOne({ _id: target._id }, { $pull: { profileViews: { user: me._id } } });
    await User.updateOne(
      { _id: target._id },
      {
        $push: {
          profileViews: {
            $each: [{ user: me._id, at: new Date() }],
            $position: 0,
            $slice: MAX_VIEWS,
          },
        },
      }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("Profile view error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/** Members who recently looked at my profile. */
router.get("/profile-views", auth, async (req, res) => {
  try {
    await dbConnect();
    // @ts-ignore
    const me = await User.findById(req.user.id).select("profileViews hideProfiles basic personal partner");
    const views = me?.profileViews || [];
    const profiles = await loadOrdered(views.map((v) => v.user));
    const viewedAt = new Map(views.map((v) => /** @type {[string, Date]} */ ([String(v.user), v.at])));
    // A viewer whose own preferences exclude me (or who is hidden) stays hidden here too.
    const activities = profiles
      .filter((p) => canView(me, p))
      .map((p) => ({ ...toPublic(p), viewedAt: viewedAt.get(String(p._id)) }));
    return res.json({ activities, count: activities.length });
  } catch (err) {
    console.error("Profile views error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

const REPORT_REASONS = [
  "Fake profile",
  "Inappropriate photos or content",
  "Asking for money",
  "Already married",
  "Abusive behaviour",
  "Other",
];

/** Report a member to support; they are also blocked for the reporter. */
router.post("/report-profile", auth, async (req, res) => {
  try {
    await dbConnect();
    const { userId, reason, details } = req.body || {};
    if (!mongoose.isValidObjectId(userId) || !REPORT_REASONS.includes(reason)) {
      return res.status(400).json({ msg: "Please choose a reason" });
    }
    // @ts-ignore
    const me = req.user;
    const target = await User.findById(userId).select("basic.fullName basic.uniqueId");
    if (!target) return res.status(404).json({ msg: "User not found" });

    await User.updateOne({ _id: me._id }, { $addToSet: { hideProfiles: target._id } });

    notify({
      to: [{ email: SUPPORT_EMAIL }],
      template_id: "user_register_2",
      variables: {
        note: "Profile reported",
        payload: `${target.basic.uniqueId} (${target.basic.fullName}) reported by ${me.basic.uniqueId}: ${reason}. ${String(details || "").slice(0, 500)}`,
      },
    });

    return res.json({
      msg: "Thank you. Our team will review this profile, and you won't see each other any more.",
    });
  } catch (err) {
    console.error("Report error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/** Block someone by their Profile ID (e.g. relatives or colleagues). */
router.post("/block-by-id", auth, async (req, res) => {
  try {
    await dbConnect();
    const uniqueId = String(req.body?.uniqueId || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(uniqueId)) {
      return res.status(400).json({ msg: "Enter a valid Profile ID" });
    }
    // @ts-ignore
    const me = req.user;
    const target = await User.findOne({ "basic.uniqueId": uniqueId }).select("_id");
    if (!target || String(target._id) === String(me._id)) {
      return res.status(404).json({ msg: "No member found with that Profile ID" });
    }
    await User.updateOne({ _id: me._id }, { $addToSet: { hideProfiles: target._id } });
    return res.json({ msg: "Blocked. Neither of you will see the other." });
  } catch (err) {
    console.error("Block error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

export default router;
