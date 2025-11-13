import axios from "axios";
import { SUPPORT_EMAIL } from "../utils/constants.js";
/**
 * Send email using MSG91 template
 * @param {Object} options
 * @param {string} options.to - recipient email
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

    return response.data;
  } catch (error) {
    console.error(
      "❌ MSG91 Email error:",
      error.response?.data || error.message
    );
    throw error;
  }
};

export default sendEmail;
