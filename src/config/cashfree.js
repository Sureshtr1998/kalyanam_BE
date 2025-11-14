import { Cashfree, CFEnvironment } from "cashfree-pg";

//   CFEnvironment.PRODUCTION,
const cf = new Cashfree(
  CFEnvironment.SANDBOX,
  process.env.CF_APP_ID,
  process.env.CF_SECRET_KEY
);

export default cf;
