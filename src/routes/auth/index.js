import { Router } from "express";
import credentialsRoutes from "./credentials.js";
import profilesRoutes from "./profiles.js";
import interestsRoutes from "./interests.js";
import accountsRoutes from "./accounts.js";
import resetPasswordsRoutes from "./resetPwd.js";
import validationRoutes from "./validations.js";
import transactionsRoutes from "./transactions.js";
import astrologyRoutes from "./astrology.js";
import reportRoutes from "./report.js";
import brokerRoutes from "./broker.js";
import adminRoutes from "./admin.js";

const router = Router();

router.use(credentialsRoutes);

router.use(profilesRoutes);

router.use(interestsRoutes);

router.use(accountsRoutes);

router.use(resetPasswordsRoutes);

router.use(validationRoutes);

router.use(transactionsRoutes);

router.use(astrologyRoutes);

router.use(reportRoutes);

router.use(brokerRoutes);

router.use(adminRoutes);

export default router;
