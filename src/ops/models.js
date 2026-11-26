import mongoose from "mongoose";
const { Schema, model } = mongoose;

/*
 * Ops agent data. Everything the agent does or plans to do is an OpsAction,
 * so the admin "Ops" tab can show it, cancel it or run it early.
 */

/** Each module runs in one of three modes. */
export const MODES = ["off", "shadow", "live"];
export const MODULES = ["ads", "organic", "support", "comments", "seo", "dev", "tools"];

const ConfigSchema = new Schema(
  {
    _id: { type: String, default: "ops" },
    modes: {
      ads: { type: String, enum: MODES, default: "shadow" },
      organic: { type: String, enum: MODES, default: "off" },
      support: { type: String, enum: MODES, default: "shadow" },
      comments: { type: String, enum: MODES, default: "shadow" },
      seo: { type: String, enum: MODES, default: "live" },
      dev: { type: String, enum: MODES, default: "live" },
      tools: { type: String, enum: MODES, default: "live" },
    },
    limits: {
      // Hard ceiling for the sum of all daily budgets (₹).
      maxDailySpend: { type: Number, default: 10000 },
      // Most the total daily budget may grow in 7 days (%).
      maxWeeklyIncreasePct: { type: Number, default: 25 },
      // One budget step, up or down (%). Small enough not to reset learning.
      stepUpPct: { type: Number, default: 10 },
      stepDownPct: { type: Number, default: 15 },
      // Return on ad spend needed before scaling (attributed revenue ÷ spend).
      scaleRoas: { type: Number, default: 1.5 },
      // Net revenue per paid member after GST and fees (₹), until real attribution exists.
      netRevenuePerMember: { type: Number, default: 285 },
      // Cost per paid member that counts as losing (₹, 3-day rolling).
      losingCostPerMember: { type: Number, default: 420 },
      // Don't scale when prepaid funds cover fewer days than this.
      minRunwayDays: { type: Number, default: 5 },
      // Hours of notice before support replies, verification and ad changes run.
      supportDelayHours: { type: Number, default: 8 },
      adNoticeHours: { type: Number, default: 24 },
      commentDeleteHours: { type: Number, default: 24 },
      // Monthly Claude API budget (USD); the agent stops calling Claude past it.
      claudeMonthlyUsd: { type: Number, default: 100 },
    },
    // Monthly targets, e.g. [{ month: "2026-12", members: 600, revenue: 210000, spend: 200000 }].
    targets: [{ month: String, members: Number, revenue: Number, spend: Number, _id: false }],
    // Facts the agent may state in replies and posts. Edited in the Ops tab.
    brief: { type: String, default: "" },
    // Manually entered plan details for third-party tools, keyed by tool id.
    tools: { type: Schema.Types.Mixed, default: {} },
    // When each periodic job last ran, keyed by job name.
    lastRuns: { type: Schema.Types.Mixed, default: {} },
    // Highest IMAP UID already read from the support inbox.
    mailLastUid: { type: Number, default: 0 },
    updatedBy: String,
  },
  { versionKey: false, timestamps: true, minimize: false }
);
export const OpsConfig = model("OpsConfig", ConfigSchema);

/**
 * One thing the agent did, will do, or wants the admin to decide.
 *  - scheduled: runs at runAt unless cancelled (the "notice" period)
 *  - needs_you: waits for an admin button (refunds, unclear cases)
 *  - idea: a suggestion for later; the admin can schedule it
 *  - shadow: what the agent would have done in shadow mode (never runs)
 */
const ActionSchema = new Schema(
  {
    module: { type: String, enum: MODULES, required: true, index: true },
    type: { type: String, required: true },
    status: {
      type: String,
      enum: ["scheduled", "needs_you", "idea", "shadow", "running", "done", "cancelled", "failed", "info"],
      default: "scheduled",
      index: true,
    },
    priority: { type: String, enum: ["low", "normal", "urgent"], default: "normal" },
    title: { type: String, required: true },
    reason: { type: String, default: "" },
    // What happens if nobody cancels, in one line.
    effect: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed, default: {} },
    runAt: { type: Date, index: true },
    ranAt: Date,
    result: { type: Schema.Types.Mixed },
    error: String,
    decidedBy: String,
    // Links to related records (mail, comment, ad set).
    ref: { kind: String, id: String },
    readAt: Date,
  },
  { versionKey: false, timestamps: true, minimize: false }
);
ActionSchema.index({ status: 1, runAt: 1 });
export const OpsAction = model("OpsAction", ActionSchema);

/** One day of Meta numbers for one entity (account, campaign, ad set or ad). */
const SnapshotSchema = new Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD, ad account time zone
    level: { type: String, enum: ["account", "campaign", "adset", "ad", "placement"], required: true },
    entityId: { type: String, required: true },
    name: String,
    campaignId: String,
    campaignName: String,
    adsetId: String,
    spend: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    // 7-day frequency up to this day (ad sets), for the fatigue rule.
    frequency7: Number,
    clicks: { type: Number, default: 0 },
    ctr: { type: Number, default: 0 },
    leads: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    // Budget and status as they were that day (ad sets and campaigns).
    dailyBudget: Number,
    status: String,
    // Account level only: prepaid funds and real joins/revenue from our database.
    funds: Number,
    joined: Number,
    earned: Number,
  },
  { versionKey: false, timestamps: true }
);
SnapshotSchema.index({ level: 1, entityId: 1, date: 1 }, { unique: true });
SnapshotSchema.index({ date: 1, level: 1 });
export const AdSnapshot = model("AdSnapshot", SnapshotSchema);

/** A mail from the support inbox and what the agent made of it. */
const MailSchema = new Schema(
  {
    uid: { type: Number, index: true },
    messageId: { type: String, index: true },
    from: { email: String, name: String },
    subject: String,
    text: String,
    receivedAt: Date,
    category: {
      type: String,
      enum: ["company", "spam", "verification", "refund", "profile_change", "question", "complaint", "urgent", "unknown"],
      default: "unknown",
    },
    language: String,
    summary: String,
    matchedUser: { type: Schema.Types.ObjectId, ref: "User" },
    draft: String,
    status: { type: String, enum: ["new", "handled", "ignored", "replied"], default: "new" },
  },
  { versionKey: false, timestamps: true }
);
export const OpsMail = model("OpsMail", MailSchema);

/** A Facebook or Instagram comment the agent has seen. */
const CommentSchema = new Schema(
  {
    platform: { type: String, enum: ["facebook", "instagram"], required: true },
    commentId: { type: String, required: true, unique: true },
    postId: String,
    author: String,
    text: String,
    createdAt: Date,
    category: { type: String, enum: ["hate", "spam", "question", "praise", "other"], default: "other" },
    language: String,
    reply: String,
    status: { type: String, enum: ["seen", "hidden", "deleted", "replied", "ignored"], default: "seen" },
  },
  { versionKey: false }
);
export const OpsComment = model("OpsComment", CommentSchema);

/** An organic post the agent wrote and scheduled. */
const PostSchema = new Schema(
  {
    publishAt: { type: Date, required: true, index: true },
    language: String,
    topic: String,
    caption: String,
    imageUrl: String,
    // ImageKit file of the image; deleted (and cleared) once Facebook/Instagram have their own copy.
    imageFileId: String,
    imageDeletedAt: Date,
    // The card the agent designs (rendered by the "Ops render" GitHub Action).
    design: { kicker: String, headline: String, subline: String, theme: String },
    renderRequests: { type: Number, default: 0 },
    renderRequestedAt: Date,
    platforms: [{ type: String, enum: ["facebook", "instagram"] }],
    // design: waiting for its image → planned → scheduled → published
    status: { type: String, enum: ["design", "planned", "scheduled", "published", "failed", "cancelled"], default: "design" },
    results: { type: Schema.Types.Mixed, default: {} },
    error: String,
  },
  { versionKey: false, timestamps: true }
);
export const OpsPost = model("OpsPost", PostSchema);

/** A new ad creative the agent designed for a tired ad set. */
const CreativeSchema = new Schema(
  {
    campaignId: String,
    campaignName: String,
    adsetId: String,
    adsetName: String,
    language: String,
    // The best ad in the campaign: its setup (link, CTA, tracking) is copied.
    baseAdId: String,
    // The weakest ad in the ad set, paused when the new one goes live.
    replaceAdId: String,
    design: { kicker: String, headline: String, subline: String, theme: String },
    primaryText: String,
    title: String,
    imageUrl: String,
    imageFileId: String,
    status: { type: String, enum: ["design", "ready", "live", "cancelled", "failed"], default: "design" },
    adId: String,
    renderRequests: { type: Number, default: 0 },
    renderRequestedAt: Date,
  },
  { versionKey: false, timestamps: true }
);
export const OpsCreative = model("OpsCreative", CreativeSchema);

/** Every Claude API call, for the monthly spend meter. */
const UsageSchema = new Schema(
  {
    task: String,
    model: String,
    inputTokens: Number,
    outputTokens: Number,
    cacheReadTokens: Number,
    usd: Number,
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);
export const OpsUsage = model("OpsUsage", UsageSchema);

/** The weekly business review and other long reports. */
const ReportSchema = new Schema(
  {
    kind: { type: String, enum: ["weekly", "seo", "monthly"], required: true },
    period: String,
    body: String,
    data: { type: Schema.Types.Mixed },
  },
  { versionKey: false, timestamps: true }
);
export const OpsReport = model("OpsReport", ReportSchema);

/** The single config document, created with defaults on first use. */
export const getConfig = async () => {
  const doc = await OpsConfig.findById("ops");
  return doc ?? OpsConfig.create({ _id: "ops", brief: DEFAULT_BRIEF });
};

export const DEFAULT_BRIEF = `Seetha Rama Kalyana (seetharamakalyana.in) is a matrimony site for Kannada, Telugu, Tamil and Hindi families.
- Joining costs ₹351 (one time). Paid members get interest credits to send interests and unlock contacts.
- Support mail: contactus@seetharamakalyana.in.
- Profiles are checked by our team before they get the verified badge.
Rules for every reply and post:
- Reply in the same language and script the person used.
- Never promise anything not written here. Never name competitors.
- Never share another member's details. Never ask for passwords or OTPs.
- Price questions: point to https://www.seetharamakalyana.in/pricing.
(Edit this brief in the Ops tab → Settings. The agent only states facts written here.)`;
