// Fields the auth middleware (src/middleware/auth.js) attaches to the request.
import "express";

declare global {
  namespace Express {
    interface Request {
      role?: "USER" | "BROKER";
      user?: any;
      broker?: any;
      staff?: {
        kind: "admin" | "broker";
        /** Mongo filter limiting which members this staff member can see. */
        scope: Record<string, any>;
      };
    }
  }
}
