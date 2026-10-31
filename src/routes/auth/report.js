import { Router } from "express";
import sendEmail from "../../config/msg91Email.js";
import { SUPPORT_EMAIL } from "../../utils/constants.js";
import { reportLimiter } from "../../middleware/otpLimiter.js";

const router = Router();

// Anonymous, so cap what one report can put in the support inbox.
const MAX_REPORT_CHARS = 4000;

router.post("/report", reportLimiter, async (req, res) => {
  try {
    await sendEmail({
      to: [{ email: SUPPORT_EMAIL }],
      template_id: "user_register_2",
      variables: {
        note: "My Profile Error",
        payload: "Error Report " + JSON.stringify(req.body ?? {}).slice(0, MAX_REPORT_CHARS),
      },
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending report:", err);
    return res.status(500).json({ error: "Failed to send error report" });
  }
});

export default router;
