import axios from "axios";
import { SUPPORT_EMAIL } from "../utils/constants.js";
import { watchMsg91Failure } from "../ops/sendHealth.js";
/**
 * Send email using MSG91 template
 * @param {Object} options
 * @param {{ email: string, name?: string }[]} options.to - recipients
 * @param {string} options.template_id - MSG91 template ID
 * @param {Object} options.variables - dynamic variables for the template
 */
const sendEmail = async ({ to, template_id, variables = {} }) => {
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

    // MSG91 can refuse inside a 200 reply; a balance refusal still reaches the owner.
    const d = response.data;
    if (d?.hasError || d?.status === "fail" || d?.type === "error") await watchMsg91Failure("email", new Error(JSON.stringify(d).slice(0, 300)));
    return response.data;
  } catch (error) {
    console.error(
      "❌ MSG91 Email error:",
      error.response?.data || error.message
    );
    // Out of email credits: the owner hears at once (Ops → sendHealth.js).
    await watchMsg91Failure("email", error);
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
