import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const auth = async (req, res, next) => {
  try {
    const token = req.header("x-auth-token");
    const secretHeader = req.header("x-internal-secret");

    // Case 1: Normal JWT flow (frontend)
    if (token) {
      const decoded = /** @type {import("jsonwebtoken").JwtPayload} */ (
        jwt.verify(token, process.env.JWT_SECRET)
      );
      const user = await User.findById(decoded.id);
      if (!user) return res.status(401).json({ msg: "User not found" });
      req.user = user;
      return next();
    }

    // Case 2: Internal (QStash) flow
    if (secretHeader === process.env.INTERNAL_ROUTE_SECRET) {
      const user = await User.findOne({ "basic.email": req.body.email });
      if (!user) return res.status(404).json({ msg: "User not found" });
      req.user = user;
      return next();
    }

    return res.status(401).json({ msg: "Unauthorized" });
  } catch (err) {
    console.error(err);
    return res.status(401).json({ msg: "Token or secret is not valid" });
  }
};
