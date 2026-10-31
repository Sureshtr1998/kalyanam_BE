// Must stay the first import: it loads .env before other modules read it.
import { allowedOrigins, isProduction } from "./config/env.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import authRoutes from "./routes/auth/index.js";
import dbConnect from "./utils/dbConnect.js";

const app = express();

// Vercel sits behind a proxy; without this every visitor shares one IP and
// the OTP / login rate limits trip for everyone at once.
app.set("trust proxy", 1);

const corsOptions = {
  origin: (origin, callback) => {
    // Non-browser callers (Razorpay webhooks, QStash) send no Origin header.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    if (
      !isProduction &&
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
};

// Middlewares
// JSON-only API: helmet's defaults (no sniffing, no framing, HSTS, no x-powered-by) all apply.
app.use(helmet());
app.use(cors(corsOptions));

// Liveness check for uptime monitors; deliberately skips the database.
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use(express.urlencoded({ extended: true }));

// Keep the raw body: Razorpay webhook signatures are computed over it.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      // @ts-ignore
      req.rawBody = buf;
    },
  })
);

app.use(async (req, res, next) => {
  try {
    await dbConnect();
    next();
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    res.status(500).json({ msg: "Database connection error" });
  }
});

// Routes
app.use("/api", authRoutes);

app.use((_req, res) => res.status(404).json({ success: false, msg: "Not found" }));

// Turn upload/body-parser errors into JSON instead of Express's HTML page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === "LIMIT_FILE_SIZE"
        ? "Each image must be under 1 MB"
        : err.code === "LIMIT_UNEXPECTED_FILE"
        ? "You can upload at most 3 images"
        : err.message;
    return res.status(400).json({ success: false, msg });
  }
  if (err?.message === "Only jpg, jpeg, png files are allowed") {
    return res.status(400).json({ success: false, msg: err.message });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ success: false, msg: "Request too large" });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, msg: "Invalid JSON body" });
  }
  console.error("Unhandled error:", err);
  return res.status(500).json({ success: false, msg: "Server error" });
});

// Vercel imports the app; locally we start a server ourselves.
// Tests import the app and drive it with supertest instead.
if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export default app;
