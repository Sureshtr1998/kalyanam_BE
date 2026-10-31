import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Broker from "../models/Broker.js";
import { isInternalRequest } from "../utils/payments.js";

const touch = (Model, doc) => {
  // "Active recently" badge; written at most every 15 minutes.
  if (!doc.lastActiveAt || Date.now() - doc.lastActiveAt.getTime() > 15 * 60 * 1000) {
    doc.lastActiveAt = new Date();
    Model.updateOne({ _id: doc._id }, { lastActiveAt: doc.lastActiveAt }).catch(() => {});
  }
};

// A password reset signs out every session that existed before it.
const issuedBeforePasswordChange = (decoded, doc) =>
  !!doc.passwordChangedAt && decoded.iat < Math.floor(doc.passwordChangedAt.getTime() / 1000);

const SESSION_ENDED = "Your password was changed. Please log in again";

/**
 * Resolves the caller from the JWT. Sets `req.role` to "USER" or "BROKER" and
 * `req.user` / `req.broker` accordingly. Returns an error message on failure.
 */
const resolveToken = async (req, token) => {
  const decoded = /** @type {import("jsonwebtoken").JwtPayload} */ (
    jwt.verify(token, process.env.JWT_SECRET)
  );
  if (decoded.role === "BROKER") {
    const broker = await Broker.findById(decoded.id);
    if (!broker) return "Partner account not found";
    if (broker.status === "suspended") return "This partner account is suspended";
    if (issuedBeforePasswordChange(decoded, broker)) return SESSION_ENDED;
    req.broker = broker;
    req.role = "BROKER";
    touch(Broker, broker);
    return null;
  }
  const user = await User.findById(decoded.id);
  if (!user) return "User not found";
  if (user.isCorrupted) return "Your profile has violated our policy. Contact admin to review your account.";
  if (issuedBeforePasswordChange(decoded, user)) return SESSION_ENDED;
  req.user = user;
  req.role = "USER";
  touch(User, user);
  return null;
};

/** Member routes. Broker tokens are refused: brokers use the /manage routes. */
export const auth = async (req, res, next) => {
  try {
    const token = req.header("x-auth-token");

    // Case 1: Normal JWT flow (frontend)
    if (token) {
      const error = await resolveToken(req, token);
      if (error) return res.status(401).json({ msg: error });
      // @ts-ignore
      if (req.role !== "USER") {
        return res.status(401).json({ msg: "Please log in with a member account" });
      }
      return next();
    }

    // Case 2: Internal (QStash) flow
    if (isInternalRequest(req)) {
      const user = await User.findOne({ "basic.email": req.body?.email });
      if (!user) return res.status(404).json({ msg: "User not found" });
      req.user = user;
      // @ts-ignore
      req.role = "USER";
      return next();
    }

    return res.status(401).json({ msg: "Unauthorized" });
  } catch (err) {
    console.error(err);
    return res.status(401).json({ msg: "Token or secret is not valid" });
  }
};

/** Like `auth`, but lets anonymous requests through with no `req.user`. */
export const optionalAuth = (req, res, next) => {
  if (!req.header("x-auth-token") && !req.header("x-internal-secret")) {
    return next();
  }
  return auth(req, res, next);
};

/** Logged-in broker only (their own dashboard data). */
export const brokerAuth = async (req, res, next) => {
  try {
    const token = req.header("x-auth-token");
    if (!token) return res.status(401).json({ msg: "Unauthorized" });
    const error = await resolveToken(req, token);
    if (error) return res.status(401).json({ msg: error });
    // @ts-ignore
    if (req.role !== "BROKER") return res.status(404).json({ msg: "Not found" });
    return next();
  } catch (err) {
    console.error(err);
    return res.status(401).json({ msg: "Token or secret is not valid" });
  }
};

/**
 * Admin members and approved brokers. Sets `req.staff`:
 *  - { kind: "admin", scope: {} } — every member
 *  - { kind: "broker", scope } — only members who registered with their code
 *    and haven't been removed from the broker's list
 */
export const staffAuth = async (req, res, next) => {
  try {
    const token = req.header("x-auth-token");
    if (!token) return res.status(401).json({ msg: "Unauthorized" });
    const error = await resolveToken(req, token);
    if (error) return res.status(401).json({ msg: error });

    // @ts-ignore
    if (req.role === "USER" && req.user.isAdmin) {
      // @ts-ignore
      req.staff = { kind: "admin", scope: {} };
      return next();
    }
    // @ts-ignore
    if (req.role === "BROKER") {
      // @ts-ignore
      const code = req.broker.referralId;
      // @ts-ignore
      req.staff = {
        kind: "broker",
        // A broker awaiting approval has no code yet, so this matches nobody.
        scope: code
          ? { "basic.referralId": code, brokerUnlinked: { $ne: true } }
          : { _id: null },
      };
      return next();
    }
    // Plain members get 404 rather than 401/403, which would sign them out.
    return res.status(404).json({ msg: "Not found" });
  } catch (err) {
    console.error(err);
    return res.status(401).json({ msg: "Token or secret is not valid" });
  }
};

/** Use after `staffAuth`: admin only. */
export const adminOnly = (req, res, next) =>
  req.staff?.kind === "admin"
    ? next()
    : res.status(404).json({ msg: "Not found" });
