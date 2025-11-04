import rateLimit from "express-rate-limit";

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,
  message: { success: false, msg: "Too many OTP requests. Try again later." },
});

export default otpLimiter;
