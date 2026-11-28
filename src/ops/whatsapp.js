import axios from "axios";
import { watchMsg91Failure } from "./sendHealth.js";

/*
 * WhatsApp alerts to the owner's own phone, sent through the same MSG91
 * account and number that send registration OTPs. WhatsApp only lets a
 * business start a chat with a Meta-approved template, so alerts use the
 * "ops_alert" template (Utility, English) with two body values:
 * {{1}} what happened, {{2}} the details.
 */

export const ALERT_TEMPLATE = { name: "ops_alert", language: "en" };

/** The template's body as it is created in MSG91 (shown in Ops → Settings). */
export const ALERT_TEMPLATE_BODY =
  "Seetha Rama Kalyana Ops alert: {{1}}\n\nDetails: {{2}}\n\nPlease open the Ops tab in the admin panel to act on it.";

export const whatsappConfigured = () =>
  Boolean(process.env.MSG91_AUTHKEY && process.env.MSG91_WHATSAPP_SENDER_ID && process.env.MSG91_WHATSAPP_API);

/** "9632972404", "+91 96329 72404", "09632972404" → "919632972404"; null unless it's an Indian mobile. */
export const normalizeWhatsapp = (s) => {
  const digits = String(s ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
};

/** Template values can't hold line breaks, tabs or runs of spaces, and must not be empty. */
export const templateText = (s, max) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "-";
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/**
 * Sends one approved template (any name, language and components such as
 * body_1 / header_1) to an Indian mobile. Throws when MSG91 refuses it.
 * @param {{ to: string, name: string, language: string, components?: object }} p
 */
export const sendWhatsappTemplate = async ({ to, name, language, components = {}, watch = true }) => {
  if (!whatsappConfigured()) throw new Error("MSG91 WhatsApp isn't set up on the server");
  const number = normalizeWhatsapp(to);
  if (!number) throw new Error("Not a 10-digit Indian mobile");
  try {
    return await postTemplate({ number, name, language, components });
  } catch (err) {
    // Out of WhatsApp balance: the owner hears at once. Not for the owner's own alerts (no loop).
    if (watch) await watchMsg91Failure("whatsapp", err);
    throw err;
  }
};

const postTemplate = async ({ number, name, language, components }) => {
  const { data } = await axios.post(
    process.env.MSG91_WHATSAPP_API,
    {
      integrated_number: process.env.MSG91_WHATSAPP_SENDER_ID,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name,
          language: { code: language, policy: "deterministic" },
          namespace: process.env.MSG91_WHATSAPP_NAMESPACE,
          to_and_components: [{ to: [number], components }],
        },
      },
    },
    { headers: { authkey: process.env.MSG91_AUTHKEY, "Content-Type": "application/json" }, timeout: 15000 }
  );
  if (data?.hasError || data?.status === "fail" || data?.type === "error") {
    const why = data?.errors ?? data?.message ?? data?.data;
    throw new Error(`MSG91 refused the WhatsApp: ${typeof why === "string" ? why : JSON.stringify(why ?? data)}`.slice(0, 300));
  }
  return data;
};

/**
 * Sends one alert. Throws when MSG91 refuses it.
 * @param {{ to: string, title: string, detail: string }} p
 */
export const sendWhatsappAlert = async ({ to, title, detail }) => {
  if (!normalizeWhatsapp(to)) throw new Error("The alert number isn't a 10-digit Indian mobile");
  return sendWhatsappTemplate({
    to,
    name: ALERT_TEMPLATE.name,
    language: ALERT_TEMPLATE.language,
    watch: false,
    components: {
      body_1: { type: "text", value: templateText(title, 200) },
      body_2: { type: "text", value: templateText(detail, 700) },
    },
  });
};
