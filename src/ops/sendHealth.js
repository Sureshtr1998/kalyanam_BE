/*
 * Watches every MSG91 send (OTP WhatsApp, reminder WhatsApp, every email) for
 * refusals that mean money ran out: the wallet, the WhatsApp balance, the
 * subscription or the email credits. The daily balance reading can't see the
 * wallet, the monthly subscription or email credits, so a failing send is the
 * one signal that covers them all (owner, 28 Nov 2026).
 *
 * The first such refusal raises an urgent card at once: email (through the
 * support mailbox, not MSG91) and WhatsApp to the owner. If WhatsApp itself is
 * what ran out, the WhatsApp can't arrive, so the email is the fallback.
 */

/** MSG91 refusals that mean a balance, plan or payment problem (not a bad number or template). */
const BALANCE_ERROR =
  /insufficient|low balance|balance (is )?(low|exhausted|insufficient|not enough)|not enough (balance|credit)|no (balance|credits?)|out of credits?|recharge|wallet|credits? (exhausted|expired|over)|plan (has )?expired|subscription (has )?(expired|inactive|ended)|payment required|quota exceeded/i;

/** The text MSG91 sent back with a refusal (axios error, MSG91 body or plain message). */
const errorText = (err) => {
  const data = err?.response?.data;
  const body = typeof data === "string" ? data : data ? JSON.stringify(data) : "";
  return `${err?.response?.status === 402 ? "payment required " : ""}${body} ${err?.message ?? err ?? ""}`.trim();
};

/** Whether a send error means MSG91 money ran out. */
export const isBalanceError = (err) => BALANCE_ERROR.test(errorText(err));

const LABEL = { whatsapp: "WhatsApp (OTPs and reminders)", email: "email (OTP emails, reminders, notifications)" };

/**
 * Records one failed MSG91 send and, when it is a balance refusal, raises the
 * urgent card. Never throws: a failed send must not fail anything else.
 * @param {"whatsapp" | "email"} channel
 * @param {unknown} err
 */
export const watchMsg91Failure = async (channel, err) => {
  try {
    if (!isBalanceError(err)) return null;
    const [{ notice }, { getConfig }] = await Promise.all([import("./actions.js"), import("./models.js")]);
    const config = await getConfig();
    const balance = config.tools?.msg91?.current;
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return await notice("tools", {
      type: "tools.msg91_failing",
      priority: "urgent",
      title: `MSG91 is refusing ${channel === "email" ? "emails" : "WhatsApp"}: out of balance`,
      reason: `MSG91 refused a ${LABEL[channel]} send for a balance or billing reason: "${errorText(err).replace(/\s+/g, " ").slice(0, 200)}".${
        channel === "whatsapp" ? " WhatsApp OTPs fail, so families can't sign up by WhatsApp." : " OTP emails and notifications fail."
      }${balance != null && channel === "whatsapp" ? ` Last WhatsApp balance reading: ₹${Math.round(balance)}.` : ""}`,
      effect:
        channel === "email"
          ? "Add email credits in MSG91 (Email → Billing) or check the email plan. Alert only."
          : "Add funds to the MSG91 wallet (WhatsApp → Billing → Add Funds) and check the subscription is paid; auto-recharge then refills WhatsApp. Alert only.",
      payload: { dedupeKey: `msg91_failing:${channel}:${day}`, whatsappKey: `msg91_failing:${channel}` },
    });
  } catch (e) {
    console.error("[ops] msg91 watch", e?.message);
    return null;
  }
};
