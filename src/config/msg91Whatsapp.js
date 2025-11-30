import axios from "axios";

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

    return response.data;
  } catch (error) {
    console.error(
      "Error sending WhatsApp OTP:",
      error.response?.data || error.message
    );
    throw error;
  }
};

export default sendWhatsappOTP;
