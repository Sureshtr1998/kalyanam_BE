import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import sendEmail from "../../config/msg91Email.js";
import User from "../../models/User.js";

const router = Router();

const remainingInterests = (user) => {
  const sent = user.interests.sent?.length ?? 0;
  const viewed = (user.interests.viewed?.length ?? 0) * 5;
  const total = user.interests.totalNoOfInterest ?? 0;

  return total - (sent + viewed);
};

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

    if (remainingInterests(sender) < 1) {
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
    const currentUser = await User.findById(req.user.id).select(
      "-basic.password -transactions"
    );

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
      "-basic.password -transactions -interests -hideProfiles -__v"
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
        basic: {
          ...user.basic,
          mobile: status === "accept" ? user.basic.mobile : undefined,
          alternateMob:
            status === "accept" ? user.basic.alternateMob : undefined,
          email: status === "accept" ? user.basic.email : undefined,
        },
      };
    });

    res.status(200).json({
      success: true,
      count: combinedList.length,
      invitations: combinedList,
      currentUser: currentUser,
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

router.post("/view-contact", auth, async (req, res) => {
  try {
    // @ts-ignore
    const sender = await User.findById(req.user.id);
    const { receiverId } = req.body;

    const receiver = await User.findById(receiverId);

    if (!sender || !receiver || req.user.id === receiverId) {
      return res.status(404).json({ msg: "User not found" });
    }

    if (sender.interests.viewed.includes(receiver._id)) {
      return res.status(400).json({ msg: "Contact already viewed" });
    }
    if (remainingInterests(sender) < 5) {
      return res.status(400).json({
        msg: "You need at least 5 remaining interests to perform this action.",
      });
    }

    sender.interests.viewed.push(receiver._id);

    await sender.save();

    res.json({ msg: "Contact Viewed successfully" });
  } catch (err) {
    console.error("Error viewing contact:", err);

    res.status(500).json({ msg: "Server error" });
  }
});

router.get("/view-contact", auth, async (req, res) => {
  try {
    // @ts-ignore
    const currentUser = await User.findById(req.user.id).select(
      "-basic.password"
    );

    if (!currentUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    // Remove duplicates
    const uniqueIds = [
      ...new Set(currentUser.interests.viewed?.map((id) => id.toString())),
    ];

    // Fetch all users at once
    const users = await User.find(
      { _id: { $in: uniqueIds } },
      "-basic.password -transactions -interests -hideProfiles -__v"
    ).lean();

    res.status(200).json({
      success: true,
      count: users.length,
      viewedNums: users,
      currentUser: currentUser,
    });
  } catch (err) {
    console.error("Error fetching invitation status:", err);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

export default router;
