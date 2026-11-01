import { Router } from "express";
import mongoose from "mongoose";
import { auth } from "../../middleware/auth.js";
import { notify } from "../../config/msg91Email.js";
import User from "../../models/User.js";
import dbConnect from "../../utils/dbConnect.js";
import { canView, isBlocked } from "../../utils/matching.js";

const router = Router();

const remainingInterests = (user) => {
  const sent = user.interests.sent?.length ?? 0;
  const viewed = (user.interests.viewed?.length ?? 0) * 5;
  const total = user.interests.totalNoOfInterest ?? 0;

  return total - (sent + viewed);
};

const hasId = (list = [], id) => list.some((x) => x.equals(id));

// Records the latest interest activity between two members on both sides.
const stampAction = (a, b) => {
  const now = new Date();
  a.interests.actedAt ??= new Map();
  b.interests.actedAt ??= new Map();
  a.interests.actedAt.set(String(b._id), now);
  b.interests.actedAt.set(String(a._id), now);
};

router.post("/send-interest", auth, async (req, res) => {
  try {
    await dbConnect();

    const { receiverId } = req.body || {};
    if (!mongoose.isValidObjectId(receiverId)) {
      return res.status(400).json({ msg: "Invalid profile" });
    }

    // @ts-ignore
    if (req.user.id === receiverId) {
      return res.status(400).json({ msg: "Cannot send interest to yourself" });
    }

    // @ts-ignore
    const sender = await User.findById(req.user.id);
    const receiver = await User.findById(receiverId);

    if (!sender || !receiver) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (hasId(sender.interests.sent, receiver._id)) {
      return res.status(400).json({ msg: "Interest already sent" });
    }

    // Two-way matching: you can only reach members whose preferences
    // include you (unless they reached out to you first).
    const theyReachedOut = hasId(sender.interests.received, receiver._id);
    if (isBlocked(sender, receiver) || (!theyReachedOut && !canView(sender, receiver))) {
      return res.status(403).json({ msg: "This profile is not available" });
    }

    if (remainingInterests(sender) < 1) {
      return res.status(400).json({
        msg: "You have reached your limit of interests. Please purchase more to continue sending.",
      });
    }

    // Add interest
    sender.interests.sent.unshift(receiver._id);
    if (!hasId(receiver.interests.received, sender._id)) {
      receiver.interests.received.unshift(sender._id);
    }
    stampAction(sender, receiver);

    // Save both users
    await sender.save();
    await receiver.save();

    notify({
      to: [{ email: receiver.basic.email }],
      template_id: "new_interest", // MSG91 Template ID
      variables: {
        user_name: receiver.basic.fullName || "",
        sender_name: sender.basic.fullName || "",
      },
    });

    res.json({ msg: "Interest sent successfully" });
  } catch (err) {
    console.error("Error sending interest:", err);

    res.status(500).json({ msg: "Server error" });
  }
});

router.get("/fetch-invitation-status", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const currentUser = await User.findById(req.user.id).select(
      "-basic.password -transactions"
    );

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    const { interests } = currentUser;

    // 1. Build ordered list (newest → oldest)
    const orderedIds = [
      ...(interests.accepted || []),
      ...(interests.declined || []),
      ...(interests.sent || []),
      ...(interests.received || []),
    ];

    const uniqueOrdered = [...new Set(orderedIds?.map(String))];

    const users = await User.find(
      { _id: { $in: uniqueOrdered } },
      "-basic.password -transactions -interests -hideProfiles -astrology -shortlisted -profileViews -__v"
    ).lean();

    const actedAt = (id) => interests.actedAt?.get(String(id)) ?? null;

    // Newest action first. Interests from before timestamps existed keep
    // their old relative order at the end (Array.sort is stable).
    const sortedUsers = uniqueOrdered
      .map((id) => users.find((u) => u._id.toString() === id))
      .filter(Boolean)
      .sort(
        (a, b) =>
          (actedAt(b._id)?.getTime() ?? 0) - (actedAt(a._id)?.getTime() ?? 0)
      );

    const finalList = sortedUsers.map((user) => {
      let status = "received";

      if (hasId(interests.accepted, user._id)) status = "accept";
      else if (hasId(interests.declined, user._id)) status = "decline";
      else if (hasId(interests.sent, user._id)) status = "sent";
      else if (hasId(interests.received, user._id)) status = "received";

      // Contact is shared once an interest is accepted, or if it was unlocked with credits.
      const showContact =
        status === "accept" || hasId(interests.viewed, user._id);
      return {
        ...user,
        interests: {
          invitationStatus: status,
          actedAt: actedAt(user._id),
        },
        basic: {
          ...user.basic,
          mobile: showContact ? user.basic.mobile : undefined,
          alternateMob: showContact ? user.basic.alternateMob : undefined,
          email: showContact ? user.basic.email : undefined,
        },
      };
    });

    res.status(200).json({
      success: true,
      count: finalList.length,
      activities: finalList,
      currentUser,
    });
  } catch (err) {
    console.error("Error fetching invitation status:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/interest-action", auth, async (req, res) => {
  try {
    await dbConnect();

    const { userId, action } = req.body || {};
    // @ts-ignore
    const currentUserId = req.user.id;

    if (
      !mongoose.isValidObjectId(userId) ||
      !["accept", "decline"].includes(action)
    ) {
      return res.status(400).json({ msg: "Invalid request data" });
    }

    const currentUser = await User.findById(currentUserId);
    const otherUser = await User.findById(userId);

    if (!currentUser || !otherUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Only an interest that was actually received can be answered. Without
    // this, "accepting" any id would reveal that member's contact details.
    if (!hasId(currentUser.interests.received, otherUser._id)) {
      return res
        .status(400)
        .json({ msg: "You have not received an interest from this member" });
    }
    if (
      hasId(currentUser.interests.accepted, otherUser._id) ||
      hasId(currentUser.interests.declined, otherUser._id)
    ) {
      return res
        .status(400)
        .json({ msg: "You have already responded to this interest" });
    }

    const field = action === "accept" ? "accepted" : "declined";
    currentUser.interests[field].unshift(otherUser._id);
    if (!hasId(otherUser.interests[field], currentUser._id)) {
      otherUser.interests[field].unshift(currentUser._id);
    }
    stampAction(currentUser, otherUser);

    await currentUser.save();
    await otherUser.save();
    if (action === "accept") {
      notify({
        to: [{ email: otherUser.basic.email }],
        template_id: "accepted_interest", // MSG91 Template ID
        variables: {
          user_name: otherUser.basic.fullName || "",
          current_user: currentUser.basic.fullName || "",
        },
      });
    }
    return res.json({
      msg: `Interest ${
        action === "accept" ? "accepted" : "declined"
      } successfully`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: "Server error" });
  }
});

router.post("/view-contact", auth, async (req, res) => {
  try {
    await dbConnect();

    const { receiverId } = req.body || {};
    // @ts-ignore
    if (!mongoose.isValidObjectId(receiverId) || req.user.id === receiverId) {
      return res.status(400).json({ msg: "Invalid profile" });
    }

    // @ts-ignore
    const sender = await User.findById(req.user.id);
    const receiver = await User.findById(receiverId);

    if (!sender || !receiver) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (hasId(sender.interests.viewed, receiver._id)) {
      return res.status(400).json({ msg: "Contact already viewed" });
    }
    const theyReachedOut = hasId(sender.interests.received, receiver._id);
    if (isBlocked(sender, receiver) || (!theyReachedOut && !canView(sender, receiver))) {
      return res.status(403).json({ msg: "This profile is not available" });
    }
    if (remainingInterests(sender) < 5) {
      return res.status(400).json({
        msg: "You need at least 5 remaining interests to perform this action.",
      });
    }

    sender.interests.viewed.unshift(receiver._id);

    await sender.save();

    res.json({ msg: "Contact Viewed successfully" });
  } catch (err) {
    console.error("Error viewing contact:", err);

    res.status(500).json({ msg: "Server error" });
  }
});

router.get("/view-contact", auth, async (req, res) => {
  try {
    await dbConnect();

    // @ts-ignore
    const currentUser = await User.findById(req.user.id).select(
      "-basic.password"
    );

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    const orderedIds = [...(currentUser.interests.viewed || [])];

    const uniqueOrdered = [...new Set(orderedIds?.map(String))];

    const users = await User.find(
      { _id: { $in: uniqueOrdered } },
      "-basic.password -transactions -interests -hideProfiles -astrology -shortlisted -profileViews -__v"
    ).lean();

    const sortedUsers = uniqueOrdered
      .map((id) => users.find((u) => u._id.toString() === id))
      .filter(Boolean);

    res.status(200).json({
      success: true,
      count: sortedUsers.length,
      activities: sortedUsers,
      currentUser,
    });
  } catch (err) {
    console.error("Error fetching viewed contacts:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
