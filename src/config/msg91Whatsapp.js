import axios from "axios";
import { watchMsg91Failure } from "../ops/sendHealth.js";

const sendWhatsappOTP = async (mobile, mobileOtp) => {
  try {
    const data = {
      integrated_number: process.env.MSG91_WHATSAPP_SENDER_ID, // Your WhatsApp-approved sender
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: "verify_code",
          language: {
            code: "en_US",
            policy: "deterministic",
          },
          namespace: process.env.MSG91_WHATSAPP_NAMESPACE,
          to_and_components: [
            {
              to: [mobile],
              components: {
                body_1: {
                  type: "text",
                  value: mobileOtp,
                },
                button_1: {
                  subtype: "url",
                  type: "text",
                  value: mobileOtp,
                },
              },
            },
          ],
        },
      },
    };
    const response = await axios.post(process.env.MSG91_WHATSAPP_API, data, {
      headers: {
        authkey: process.env.MSG91_AUTHKEY,
        "Content-Type": "application/json",
      },
    });

    // MSG91 can refuse inside a 200 reply; a balance refusal still reaches the owner.
    const d = response.data;
    if (d?.hasError || d?.status === "fail" || d?.type === "error") await watchMsg91Failure("whatsapp", new Error(JSON.stringify(d).slice(0, 300)));
    return response.data;
  } catch (error) {
    console.error(
      "Error sending WhatsApp OTP:",
      error.response?.data || error.message
    );
    // Out of WhatsApp balance: the owner hears at once (Ops → sendHealth.js).
    await watchMsg91Failure("whatsapp", error);
    throw error;
  }
};

export default sendWhatsappOTP;
