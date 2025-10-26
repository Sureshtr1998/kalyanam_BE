import { Router } from "express";
import { auth } from "../../middleware/auth.js";
import transporter from "../../config/nodeMailer.js";
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

    if (sender.sent.includes(receiver._id)) {
      return res.status(400).json({ msg: "Interest already sent" });
    }

    // Add interest
    sender.sent.push(receiver._id);
    receiver.received.push(sender._id);

    // Save both users
    await sender.save();
    await receiver.save();

    await transporter.sendMail({
      from: `"Seetha Rama Kalyana" <${process.env.EMAIL_USER}>`,
      to: receiver.email,
      subject: "New Interest Received on Seetha Rama Kalyana",
      html: `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; border:1px solid #eaeaea; padding:20px; border-radius:10px;">
      <h2 style="color:#007BFF;">You’ve Received a New Interest 💌</h2>
      <p>Dear ${receiver.fullName || "User"},</p>
      <p><b>${
        sender.fullName
      }</b> has shown interest in your profile on <b>Seetha Rama Kalyana</b>.</p>
      <p>Visit your profile Invitation Status to view their details and decide whether to <b>Accept</b> or <b>Decline</b> the interest.</p>
      <div style="text-align:center; margin-top:20px;">
        <a href="${
          process.env.FRONTEND_URL
        }/invitations" style="background-color:#007BFF; color:#fff; padding:10px 20px; text-decoration:none; border-radius:5px;">View Interest</a>
      </div>
      <p style="margin-top:30px;">Thank you for using <b>Seetha Rama Kalyana</b>.</p>
    </div>
  `,
    });

    res.json({ msg: "Interest sent successfully" });
  } catch (err) {
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
      ...(currentUser.sent || []),
      ...(currentUser.received || []),
      ...(currentUser.accepted || []),
      ...(currentUser.declined || []),
    ];

    // Remove duplicates
    const uniqueIds = [...new Set(allIds.map((id) => id.toString()))];

    // Fetch all users at once
    const users = await User.find(
      { _id: { $in: uniqueIds } },
      "-password -email -__v"
    ).lean();

    // Map each user to correct invitationStatus based on priority
    const combinedList = users.map((user) => {
      let status = "received"; // default

      // @ts-ignore
      if (currentUser.accepted?.includes(user._id.toString())) {
        status = "accept";
        // @ts-ignore
      } else if (currentUser.declined?.includes(user._id.toString())) {
        status = "decline";
        // @ts-ignore
      } else if (currentUser.sent?.includes(user._id.toString())) {
        status = "sent";
        // @ts-ignore
      } else if (currentUser.received?.includes(user._id.toString())) {
        status = "received";
      }

      return {
        ...user,
        invitationStatus: status,
        mobile: status === "accept" ? user.mobile : undefined,
        alternateMob: status === "accept" ? user.alternateMob : undefined,
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
      currentUser.accepted = [
        ...(currentUser.accepted || []),
        userId.toString(),
      ];
      otherUser.accepted = [
        ...(otherUser.accepted || []),
        currentUserId.toString(),
      ];
    } else if (action === "decline") {
      currentUser.declined = [
        ...(currentUser.declined || []),
        userId.toString(),
      ];
      otherUser.declined = [
        ...(otherUser.declined || []),
        currentUserId.toString(),
      ];
    }

    await currentUser.save();
    await otherUser.save();
    if (action === "accept") {
      await transporter.sendMail({
        from: `"Seetha Rama Kalyana" <${process.env.EMAIL_USER}>`,
        to: otherUser.email, // original sender of the interest
        subject: "Your Interest Has Been Accepted 💖",
        html: `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:auto; border:1px solid #eaeaea; padding:20px; border-radius:10px;">
      <h2 style="color:#28a745;">Good News! Your Interest Was Accepted 💖</h2>
      <p>Dear ${otherUser.fullName || "User"},</p>
      <p><b>${
        currentUser.fullName
      }</b> has accepted your interest on <b>Seetha Rama Kalyana</b>.</p>
      <p>You can now view their contact details and continue your conversation.</p>
      <div style="text-align:center; margin-top:20px;">
        <a href="${
          process.env.FRONTEND_URL
        }/login" style="background-color:#28a745; color:#fff; padding:10px 20px; text-decoration:none; border-radius:5px;">View Profile</a>
      </div>
      <p style="margin-top:30px;">We wish you all the best in your journey together!</p>
      <p>– The <b>Seetha Rama Kalyana</b> Team</p>
    </div>
  `,
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
