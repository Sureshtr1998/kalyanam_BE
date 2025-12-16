import { Router } from "express";
import sendEmail from "../../config/msg91Email.js";
import { SUPPORT_EMAIL } from "../../utils/constants.js";

const router = Router();

router.post("/report", async (req, res) => {
  try {
    await sendEmail({
      to: [{ email: SUPPORT_EMAIL }],
      template_id: "user_register_2",
      variables: {
        note: "My Profile Error",
        payload: "Error Report " + JSON.stringify(req.body),
      },
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending report:", err);
    return res.status(500).json({ error: "Failed to send error report" });
  }
});

export default router;
