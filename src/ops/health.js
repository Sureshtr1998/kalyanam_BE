import { OpsAction, OpsConfig } from "./models.js";

/*
 * Vital member flows report each try here. Several failures in a row, with no
 * success between, mean the flow is broken (not one member's typo), and the
 * owner hears at once on WhatsApp. The next success marks the alert resolved.
 */

const FLOWS = {
  otp: {
    label: "Registration OTPs are failing",
    effect: "New members and partners can't register until this works. Check MSG91 (WhatsApp and email) and the server logs on Vercel.",
  },
};

/** Failures in a row before the owner hears. */
export const FLOW_ALERT_AT = 3;
/** MSG91 balance errors: funds are the owner's to watch, so no WhatsApp for them. */
const FUNDS_ERROR = /(balance|insufficient|recharge|credit|wallet)/i;

const errorText = (err) => {
  const data = err?.response?.data;
  const detail = data?.message ?? data?.errors ?? data?.msg;
  return String(detail ? (typeof detail === "string" ? detail : JSON.stringify(detail)) : err?.message ?? err).slice(0, 300);
};

/** Records one failure of a flow; the 3rd in a row raises an urgent alert. Never throws. */
export const flowFailed = async (name, err) => {
  try {
    const message = errorText(err);
    const doc = await OpsConfig.findOneAndUpdate(
      { _id: "ops" },
      { $inc: { [`health.${name}.fails`]: 1 }, $set: { [`health.${name}.lastError`]: message, [`health.${name}.lastFailAt`]: new Date() } },
      { new: true, projection: { [`health.${name}`]: 1 } }
    ).lean();
    const fails = doc?.health?.[name]?.fails ?? 0;
    if (fails !== FLOW_ALERT_AT) return;
    const { notice } = await import("./actions.js");
    await notice("tools", {
      type: "ops.flow_failing",
      priority: "urgent",
      title: FLOWS[name]?.label ?? `${name} is failing`,
      reason: `The last ${fails} tries failed, none worked in between. Last error: ${message}`,
      effect: FLOWS[name]?.effect ?? "Check the server logs on Vercel.",
      payload: {
        dedupeKey: `flow:${name}:${new Date().toISOString().slice(0, 13)}`,
        flow: name,
        ...(FUNDS_ERROR.test(message) ? { whatsapp: false } : {}),
      },
    });
  } catch (e) {
    console.error(`[ops] health ${name}`, e.message);
  }
};

/** Records a success: the failure count restarts and open alerts are marked resolved. Never throws. */
export const flowOk = async (name) => {
  try {
    const r = await OpsConfig.updateOne({ _id: "ops", [`health.${name}.fails`]: { $gt: 0 } }, { $set: { [`health.${name}.fails`]: 0 } });
    if (!r.modifiedCount) return;
    await OpsAction.updateMany(
      { type: "ops.flow_failing", "payload.flow": name, status: "info", "payload.resolvedAt": null },
      { $set: { "payload.resolvedAt": new Date() } }
    );
  } catch (e) {
    console.error(`[ops] health ${name}`, e.message);
  }
};
