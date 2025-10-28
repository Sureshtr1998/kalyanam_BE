import { Router } from "express";
import credentialsRoutes from "./credentials.js";
import profilesRoutes from "./profiles.js";
import interestsRoutes from "./interests.js";
import accountsRoutes from "./accounts.js";
import resetPasswordsRoutes from "./resetPwd.js";
import validationRoutes from "./validations.js";

const router = Router();

// POST /api/login & POST /api/user-register
router.use(credentialsRoutes);

// POST /api/fetch-profiles & GET /api/my-profile & POST /api/my-profile & /my-profile/upload-images
router.use(profilesRoutes);

//POST /api/send-interest & GET /api/fetch-invitation-status & POST /api/interest-action
router.use(interestsRoutes);

//DELETE /api/delete-account & GET /api/user-account & POST /api/hide-profile
router.use(accountsRoutes);

//POST /api/request-reset & POST /api/reset-password & POST /api/verify-otp
router.use(resetPasswordsRoutes);

//POST /api/verify-otp & POST /api/send-otp
router.use(validationRoutes);

export default router;
