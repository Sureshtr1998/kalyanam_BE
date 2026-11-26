import crypto from "crypto";

/*
 * A short-lived pass for the "Ops render" GitHub Action, sent with each
 * render request (repository_dispatch client_payload). It lets the Action
 * fetch the render queue and post images back for 3 hours, without storing
 * any long-lived secret in GitHub.
 */

const TTL = 3 * 3600_000;
const sign = (exp) => crypto.createHmac("sha256", `${process.env.INTERNAL_ROUTE_SECRET}:ops-render`).update(String(exp)).digest("hex");

export const signRenderToken = (now = Date.now()) => {
  const exp = now + TTL;
  return `${exp}.${sign(exp)}`;
};

export const verifyRenderToken = (token) => {
  if (!process.env.INTERNAL_ROUTE_SECRET || typeof token !== "string") return false;
  const [exp, mac] = token.split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(mac);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};
