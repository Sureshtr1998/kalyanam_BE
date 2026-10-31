import axios from "axios";
import { SUPPORT_EMAIL } from "../utils/constants.js";
/**
 * Send email using MSG91 template
 * @param {Object} options
 * @param {{ email: string }[]} options.to - recipient email
 * @param {string} options.template_id - MSG91 template ID
 * @param {Object} options.variables - dynamic variables for the template
 */
const sendEmail = async ({ to, template_id, variables = {} }) => {
  if (template_id === "user_register_2") return;
  try {
    const response = await axios.post(
      process.env.MSG91_EMAIL_API,
      {
        recipients: [
          {
            to,
            // These are template variables that MSG91 replaces dynamically
            variables: {
              ...variables,
              contactEmail: SUPPORT_EMAIL,
            },
          },
        ],
        from: {
          email: process.env.MSG91_EMAIL_FROM,
          name: "Seetha Rama Kalyana Support",
        },
        template_id,
        domain: process.env.MSG91_DOMAIN,
      },
      {
        headers: {
          authkey: process.env.MSG91_AUTHKEY,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      "❌ MSG91 Email error:",
      error.response?.data || error.message
    );
    throw error;
  }
};

/**
 * Fire-and-forget notification. Use after the database write has committed,
 * so a mail-provider outage never turns a successful action into a 500.
 */
export const notify = async (options) => {
  try {
    await sendEmail(options);
  } catch {
    // already logged by sendEmail
  }
};

export default sendEmail;
