import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import sendEmail from "../../config/msg91Email.js";
import User from "../../models/User.js";

const router = Router();

router.post("/send-interest", auth, async (req, res) => {
  try {
    // @ts-ignore
    const sender = await User.findById(req.user.id);
    const { receiverId } = req.body;

    const receiver = await User.findById(receiverId);

    if (!sender || !receiver) {
      return res.status(404).json({ msg: "User not found" });
    }

    // @ts-ignore
    if (req.user.id === receiverId) {
      return res.status(400).json({ msg: "Cannot send interest to yourself" });
    }

    if (sender.interests.sent.includes(receiver._id)) {
      return res.status(400).json({ msg: "Interest already sent" });
    }

    if (
      (sender.interests.totalNoOfInterest ?? 0) <= sender.interests.sent.length
    ) {
      return res.status(400).json({
        msg: "You have reached your limit of interests. Please purchase more to continue sending.",
      });
    }

    // Add interest
    sender.interests.sent.push(receiver._id);
    receiver.interests.received.push(sender._id);

    // Save both users
    await sender.save();
    await receiver.save();

    await sendEmail({
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
    // @ts-ignore
    const currentUser = await User.findById(req.user.id);

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Combine all IDs
    const allIds = [
      ...(currentUser.interests.sent || []),
      ...(currentUser.interests.received || []),
      ...(currentUser.interests.accepted || []),
      ...(currentUser.interests.declined || []),
    ];

    // Remove duplicates
    const uniqueIds = [...new Set(allIds.map((id) => id.toString()))];

    // Fetch all users at once
    const users = await User.find(
      { _id: { $in: uniqueIds } },
      "-basic.password -basic.email -basic.alternateMob -basic.mobile -__v"
    ).lean();

    const combinedList = users.map((user) => {
      let status = "received";

      if (currentUser.interests.accepted?.includes(user._id)) {
        status = "accept";
      } else if (currentUser.interests.declined?.includes(user._id)) {
        status = "decline";
      } else if (currentUser.interests.sent?.includes(user._id)) {
        status = "sent";
      } else if (currentUser.interests.received?.includes(user._id)) {
        status = "received";
      }

      return {
        ...user,
        interests: {
          ...user.interests,
          invitationStatus: status,
        },
        mobile: status === "accept" ? user.basic.mobile : undefined,
        alternateMob: status === "accept" ? user.basic.alternateMob : undefined,
      };
    });

    res.status(200).json({
      success: true,
      count: combinedList.length,
      invitations: combinedList,
    });
  } catch (err) {
    console.error("Error fetching invitation status:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

router.post("/interest-action", auth, async (req, res) => {
  try {
    const { userId, action } = req.body;
    // @ts-ignore
    const currentUserId = req.user.id;

    if (!userId || !["accept", "decline"].includes(action)) {
      return res.status(400).json({ msg: "Invalid request data" });
    }

    const currentUser = await User.findById(currentUserId);
    const otherUser = await User.findById(userId);

    if (!currentUser || !otherUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (action === "accept") {
      currentUser.interests.accepted = [
        ...(currentUser.interests.accepted || []),
        userId.toString(),
      ];
      otherUser.interests.accepted = [
        ...(otherUser.interests.accepted || []),
        currentUserId.toString(),
      ];
    } else if (action === "decline") {
      currentUser.interests.declined = [
        ...(currentUser.interests.declined || []),
        userId.toString(),
      ];
      otherUser.interests.declined = [
        ...(otherUser.interests.declined || []),
        currentUserId.toString(),
      ];
    }

    await currentUser.save();
    await otherUser.save();
    if (action === "accept") {
      await sendEmail({
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

export default router;
