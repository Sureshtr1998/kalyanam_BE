import Settings from "../models/Settings.js";

/*
 * Every price the site charges, by pricing level. An admin picks the live
 * level from the panel (/manage/pricing); the tables themselves only change
 * here, so nobody can mistype a price. The frontend reads the live row from
 * GET /pricing.
 *
 * Level 1 makes registration free (no payment at all); packs and astrology
 * stay paid at level 2's prices. Each order stores its amount when it is
 * created, so switching levels never changes a checkout in progress.
 */
export const PRICING_LEVELS = {
  1: {
    registrationFee: 0,
    registrationFeeOriginal: null,
    registrationInterests: 5,
    referralFee: 0,
    brokerCommission: 0,
    interestPacks: {
      basic: { amount: 81, interests: 21 },
      premium: { amount: 201, interests: 56 },
    },
    astroFees: { Overview: 41, Personalized: 201, "Kundli Matching": 151 },
    brokerRegistrationFee: 501,
  },
  2: {
    registrationFee: 201,
    registrationFeeOriginal: 599,
    registrationInterests: 21,
    referralFee: 171,
    brokerCommission: 51,
    interestPacks: {
      basic: { amount: 81, interests: 21 },
      premium: { amount: 201, interests: 56 },
    },
    astroFees: { Overview: 41, Personalized: 201, "Kundli Matching": 151 },
    brokerRegistrationFee: 501,
  },
  3: {
    registrationFee: 351,
    registrationFeeOriginal: 999,
    registrationInterests: 36,
    referralFee: 301,
    brokerCommission: 101,
    interestPacks: {
      basic: { amount: 101, interests: 21 },
      premium: { amount: 251, interests: 56 },
    },
    astroFees: { Overview: 51, Personalized: 251, "Kundli Matching": 201 },
    brokerRegistrationFee: 501,
  },
  4: {
    registrationFee: 501,
    registrationFeeOriginal: 1499,
    registrationInterests: 51,
    referralFee: 431,
    brokerCommission: 151,
    interestPacks: {
      basic: { amount: 121, interests: 21 },
      premium: { amount: 301, interests: 56 },
    },
    astroFees: { Overview: 71, Personalized: 301, "Kundli Matching": 251 },
    brokerRegistrationFee: 501,
  },
};

export const DEFAULT_PRICING_LEVEL = 3;

// Members referred before commissions were stored per member earned this.
export const LEGACY_BROKER_COMMISSION = 101;

const SETTINGS_ID = "global";

export const isPricingLevel = (level) =>
  Object.prototype.hasOwnProperty.call(PRICING_LEVELS, String(level));

/** The live level and its prices. One small read; no cache, so every serverless instance agrees. */
export const getPricing = async () => {
  const settings = await Settings.findById(SETTINGS_ID).lean();
  const level = isPricingLevel(settings?.pricingLevel) ? settings.pricingLevel : DEFAULT_PRICING_LEVEL;
  return { level, ...PRICING_LEVELS[level] };
};

export const getPricingSettings = async () => {
  const settings = await Settings.findById(SETTINGS_ID).lean();
  return {
    level: isPricingLevel(settings?.pricingLevel) ? settings.pricingLevel : DEFAULT_PRICING_LEVEL,
    updatedBy: settings?.pricingUpdatedBy ?? null,
    updatedAt: settings?.pricingUpdatedAt ?? null,
  };
};

export const setPricingLevel = (level, updatedBy) =>
  Settings.findByIdAndUpdate(
    SETTINGS_ID,
    { pricingLevel: level, pricingUpdatedBy: updatedBy, pricingUpdatedAt: new Date() },
    { upsert: true }
  );

/** Mongo expression: the commission a referred member earned their broker. */
export const COMMISSION_OF = { $ifNull: ["$commission", LEGACY_BROKER_COMMISSION] };
