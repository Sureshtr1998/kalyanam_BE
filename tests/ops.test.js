import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mailbox and Claude are replaced; everything else is the real app.
const inbox = [];
const sent = [];
vi.mock("../src/ops/mail.js", () => ({
  mailConfigured: () => true,
  fetchNewMail: vi.fn(async (lastUid) => inbox.filter((m) => m.uid > lastUid)),
  sendMail: vi.fn(async (m) => {
    sent.push(m);
    return { messageId: "<sent@test>" };
  }),
  testMailLogin: vi.fn(async () => ({ messages: 1 })),
}));
const triage = vi.fn();
const ideaPlan = vi.fn();
const organicPlan = vi.fn();
const adsWrite = vi.fn();
const organicReview = vi.fn(() => ({ reviews: [] }));
const organicDaily = vi.fn(() => ({ items: [] }));
const standingIdea = vi.fn(() => ({ label: "Second marriages", hint: "Families looking again after a divorce or loss.", facts: "", path: "" }));
const adsReview = vi.fn();
const metaRead = vi.hoisted(() => ({ scheduledDays: [], scheduledTimes: [], performance: [], structure: { campaigns: [], adsets: [] }, ads: null }));
const commentTriage = vi.fn();
const metaCalls = vi.hoisted(() => ({ setStatus: vi.fn(async () => ({})), setDailyBudget: vi.fn(async () => ({})), deleteFacebookPost: vi.fn(async () => ({ success: true })), graphDelete: vi.fn(async () => ({ success: true })) }));
const hidden = [];
vi.mock("../src/ops/meta.js", async (orig) => ({
  ...(await orig()),
  pageConfigured: () => true,
  igConfigured: () => false,
  fetchPageComments: vi.fn(async () => [
    { platform: "facebook", commentId: "fb_1", postId: "p1", author: "Angry User", text: "I paid 351 no use, fake app", createdAt: new Date(), hidden: false, ours: false },
    { platform: "facebook", commentId: "fb_2", postId: "p1", author: "Kind User", text: "Nice service", createdAt: new Date(), hidden: false, ours: false },
  ]),
  hideComment: vi.fn(async (_p, id) => hidden.push(id)),
  replyToComment: vi.fn(async () => ({ id: "r1" })),
  scheduleFacebookPhoto: vi.fn(async () => ({ id: "fbpost_1" })),
  publishInstagramPhoto: vi.fn(async () => ({ id: "igpost_1" })),
  publishInstagramStory: vi.fn(async () => ({ id: "igstory_1" })),
  publishFacebookStory: vi.fn(async () => ({ post_id: "fbstory_1" })),
  fetchLiveStories: vi.fn(async () => metaRead.stories ?? []),
  lastInsightErrors: vi.fn(() => ({})),
  fetchCreativeSpec: vi.fn(async () => ({
    object_story_spec: { page_id: "pg1", link_data: { link: "https://www.seetharamakalyana.in/kn", message: "old", name: "old", picture: "x", call_to_action: { type: "SIGN_UP" } } },
    url_tags: "utm_source=meta",
  })),
  uploadAdImage: vi.fn(async () => "hash_1"),
  fetchAdImage: vi.fn(async (id) => ({ mediaType: "image/jpeg", data: Buffer.from(`img-${id}`).toString("base64") })),
  fetchScheduledDays: vi.fn(async () => metaRead.scheduledDays),
  fetchScheduledTimes: vi.fn(async () => metaRead.scheduledTimes),
  fetchScheduledPosts: vi.fn(async () => metaRead.scheduledTimes.map((at, i) => ({ id: `sp${i}`, at, message: "" }))),
  deleteFacebookPost: metaCalls.deleteFacebookPost,
  graphDelete: metaCalls.graphDelete,
  fetchPostPerformance: vi.fn(async () => metaRead.performance),
  fetchAds: vi.fn(async () => metaRead.ads ?? [{ id: "ad_kn1", name: "KN-09 Why351", adset_id: "s_kn", campaign_id: "c_kn", effective_status: "ACTIVE" }]),
  fetchStructure: vi.fn(async () => metaRead.structure),
  createCreative: vi.fn(async () => ({ id: "cr_1" })),
  copyAd: vi.fn(async () => "ad_new"),
  graphPost: vi.fn(async () => ({ success: true })),
  setStatus: metaCalls.setStatus,
  setDailyBudget: metaCalls.setDailyBudget,
}));
vi.mock("../src/ops/claude.js", () => ({
  claudeConfigured: () => true,
  monthSpendUsd: async () => 0,
  spendSummary: async () => ({ totalUsd: 1.5, totalCalls: 10, monthUsd: 0.5, byTask: [] }),
  inrRate: async () => 88,
  ClaudeUnavailable: class extends Error {},
  ask: vi.fn(async ({ task }) => (task === "support.triage" ? triage() : task === "comments.triage" ? commentTriage() : task === "ideas.plan" ? ideaPlan() : task === "organic.plan" ? organicPlan() : task === "organic.plan_daily" ? organicDaily() : task === "ideas.standing" ? standingIdea() : task === "ads.creatives" ? adsWrite() : task === "ads.review" ? adsReview() : task === "organic.review" ? organicReview() : "ನಮಸ್ಕಾರ, ನಿಮ್ಮ ಖಾತೆ ಪರಿಶೀಲಿಸಲಾಗಿದೆ. — Team Seetha Rama Kalyana")),
}));

const { api, createUser, tokenFor } = await import("./helpers.js");
const { OpsAction, OpsConfig, OpsMail, OpsPost, OpsCreative } = await import("../src/ops/models.js");
await import("../src/ops/adsCreative.js");
await import("../src/ops/ads.js");
const { default: imagekit } = await import("../src/config/imageKit.js");
const { runSupportCycle } = await import("../src/ops/support.js");
const { execute, runDue } = await import("../src/ops/actions.js");
const { runCommentsCycle } = await import("../src/ops/comments.js");
const { default: User } = await import("../src/models/User.js");
const { default: dbConnect } = await import("../src/utils/dbConnect.js");

const mail = (uid, from, text, extra = {}) => ({
  uid,
  messageId: `<m${uid}@test>`,
  from: { email: from, name: "Ramesh" },
  subject: "OTP not received",
  text,
  receivedAt: new Date(),
  headers: {},
  ...extra,
});

// QStash (the 15-minute schedule) is faked; every other request goes through untouched.
const qstashCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://qstash.upstash.io/")) {
    qstashCalls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers });
    return new Response(JSON.stringify({ scheduleId: "scd_test" }), { status: 201 });
  }
  return realFetch(url, init);
};

beforeEach(async () => {
  await dbConnect();
  inbox.length = 0;
  sent.length = 0;
  triage.mockReset();
  await Promise.all([OpsAction.deleteMany({}), OpsMail.deleteMany({}), OpsConfig.deleteMany({})]);
});

describe("Ops API access", () => {
  it("hides the Ops API from members", async () => {
    const member = await createUser();
    const res = await api().get("/api/manage/ops/overview").set("x-auth-token", tokenFor(member));
    expect(res.status).toBe(404);
  });

  it("gives admins the overview with safe defaults", async () => {
    const admin = await createUser({ rest: { isAdmin: true } });
    const res = await api().get("/api/manage/ops/overview").set("x-auth-token", tokenFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.modes).toMatchObject({ ads: "shadow", support: "shadow", organic: "off" });
    expect(res.body.limits.supportDelayHours).toBe(8);
  });

  it("rejects an unknown mode", async () => {
    const admin = await createUser({ rest: { isAdmin: true } });
    await api().post("/api/manage/ops/config").set("x-auth-token", tokenFor(admin)).send({ modes: { ads: "yolo", support: "live" } });
    const res = await api().get("/api/manage/ops/overview").set("x-auth-token", tokenFor(admin));
    expect(res.body.modes).toMatchObject({ ads: "shadow", support: "live" });
  });

  it("refuses the tick without the cron secret", async () => {
    const res = await api().post("/api/ops/tick");
    expect(res.status).toBe(401);
  });
});

describe("support mail", () => {
  const goLive = () => OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.support": "live" } }, { upsert: true });

  it("ignores company mail without calling Claude", async () => {
    inbox.push(mail(1, "noreply@razorpay.com", "Settlement processed"));
    await runSupportCycle();
    expect(triage).not.toHaveBeenCalled();
    expect((await OpsMail.findOne({ uid: 1 })).category).toBe("company");
  });

  it("only logs a verification in shadow mode", async () => {
    const user = await createUser();
    triage.mockReturnValue({ category: "verification", language: "Kannada (Kannada script)", summary: "No OTP", mobile: user.basic.mobile, email: "", confidence: 0.9 });
    inbox.push(mail(2, user.basic.email, `OTP barlilla, ${user.basic.mobile}`));
    await runSupportCycle();
    const a = await OpsAction.findOne({ type: "support.verify" });
    expect(a.status).toBe("shadow");
  });

  it("verifies after the notice period when mobile and email match one account", async () => {
    await goLive();
    const user = await createUser();
    triage.mockReturnValue({ category: "verification", language: "Kannada (Kannada script)", summary: "No OTP", mobile: `+91 ${user.basic.mobile}`, email: "", confidence: 0.9 });
    inbox.push(mail(3, user.basic.email, "help"));
    await runSupportCycle();
    const a = await OpsAction.findOne({ type: "support.verify" });
    expect(a.status).toBe("scheduled");
    const hours = (a.runAt.getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThan(8.1);

    await execute(a._id);
    expect((await User.findById(user._id)).isVerified).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(user.basic.email);
    expect(sent[0].text).not.toMatch(/Secret@123|password:/i);
  });

  it("answers several mails from the same person with one reply", async () => {
    await goLive();
    await OpsAction.deleteMany({});
    triage.mockReturnValue({ category: "question", language: "English", summary: "Asks about price", mobile: "", email: "", confidence: 0.9 });
    inbox.push(mail(21, "same.person@example.test", "How much is it?"));
    inbox.push(mail(22, "same.person@example.test", "Hello? Any update on the price?"));
    await runSupportCycle();
    const cards = await OpsAction.find({ type: "support.reply", "payload.to": "same.person@example.test" }).sort({ createdAt: 1 });
    expect(cards.map((c) => c.status)).toEqual(["cancelled", "scheduled"]);
    expect(cards[0].error).toMatch(/Replaced/);
    expect(cards[1].reason).toMatch(/They wrote 2 times/);
  });

  it("asks the admin when the mobile belongs to a different email", async () => {
    await goLive();
    const user = await createUser();
    triage.mockReturnValue({ category: "verification", language: "English", summary: "No OTP", mobile: user.basic.mobile, email: "", confidence: 0.9 });
    inbox.push(mail(4, "someone.else@example.test", "verify me"));
    await runSupportCycle();
    const a = await OpsAction.findOne({ "ref.kind": "mail" });
    expect(a.status).toBe("needs_you");
    expect(await OpsAction.exists({ type: "support.verify" })).toBeNull();
    expect((await User.findById(user._id)).isVerified).toBe(false);
  });

  it("never refunds on its own", async () => {
    await goLive();
    const user = await createUser({ rest: { transactions: [{ orderId: "o1", paymentId: "pay_1", amountPaid: 351, note: "Registration" }] } });
    triage.mockReturnValue({ category: "refund", language: "English", summary: "Wants money back", mobile: "", email: "", confidence: 0.9 });
    inbox.push(mail(5, user.basic.email, "refund please"));
    await runSupportCycle();
    const a = await OpsAction.findOne({ type: "support.refund" });
    expect(a.status).toBe("needs_you");
    expect(a.runAt).toBeUndefined();
    expect(a.payload.payments).toEqual([expect.objectContaining({ paymentId: "pay_1", amount: 351 })]);
  });

  it("schedules a drafted reply for questions and reads each mail once", async () => {
    await goLive();
    triage.mockReturnValue({ category: "question", language: "Telugu (Telugu script)", summary: "Asks about price", mobile: "", email: "", confidence: 0.9 });
    inbox.push(mail(6, "family@example.test", "dhara entha?"));
    await runSupportCycle();
    await runSupportCycle();
    const replies = await OpsAction.find({ type: "support.reply" });
    expect(replies).toHaveLength(1);
    expect(replies[0].status).toBe("scheduled");
    expect(replies[0].payload.draft).toBeTruthy();
  });
});

describe("comments", () => {
  it("puts a paying member's complaint on the hide card itself", async () => {
    await OpsAction.deleteMany({});
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.comments": "live" } }, { upsert: true });
    const meta = await import("../src/ops/meta.js");
    meta.fetchPageComments.mockResolvedValueOnce([
      { platform: "facebook", commentId: "fb_paid", author: "Ravi", text: "I paid 351 and got nothing", createdAt: new Date(), ours: false, hidden: false },
    ]);
    commentTriage.mockReturnValue({ items: [{ id: "fb_paid", category: "hate", language: "English", reply: "" }] });
    await runCommentsCycle();
    const cards = await OpsAction.find({ "ref.id": "fb_paid" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ priority: "urgent" });
    expect(cards[0].title).toMatch(/complained about paying/);
    expect(await OpsAction.exists({ type: "comments.paid_complaint" })).toBeNull();
  });

  it("hides negative remarks about the service, queues deletion and flags paid complaints", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.comments": "live" } }, { upsert: true });
    commentTriage.mockReturnValue({
      items: [
        { id: "fb_1", category: "hate", language: "English", reply: "" },
        { id: "fb_2", category: "praise", language: "English", reply: "Thank you!" },
      ],
    });
    await runCommentsCycle();
    await runDue(Date.now() + 20000);
    expect(hidden).toEqual(["fb_1"]);
    // One card per comment: hidden, then the same card waits to delete it.
    const cards = await OpsAction.find({ "ref.id": "fb_1" });
    expect(cards).toHaveLength(1);
    const del = cards[0];
    expect(del.type).toBe("comments.delete");
    expect(del.status).toBe("scheduled");
    expect(del.result.steps).toEqual([expect.objectContaining({ type: "comments.hide" })]);
    expect((del.runAt.getTime() - Date.now()) / 3600000).toBeGreaterThan(23.9);
    expect((await OpsAction.findOne({ type: "comments.reply" })).status).toBe("done");
  });
});

describe("post image rendering", () => {
  const secret = () => ({ "x-internal-secret": process.env.INTERNAL_ROUTE_SECRET });

  it("keeps the render queue private", async () => {
    expect((await api().get("/api/ops/render-queue")).status).toBe(401);
    expect((await api().post("/api/ops/render-done").send({})).status).toBe(401);
  });

  it("hands posts to the renderer, stores the image and queues scheduling", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.organic": "live" } }, { upsert: true });
    await OpsPost.deleteMany({});
    const post = await OpsPost.create({
      publishAt: new Date(Date.now() + 3 * 86400000),
      language: "Kannada",
      topic: "Family values",
      caption: "caption",
      design: { kicker: "ಕುಟುಂಬ", headline: "ಎರಡು ಕುಟುಂಬಗಳು, ಒಂದು ಹೊಸ ಆರಂಭ", subline: "ಹಿರಿಯರ ಆಶೀರ್ವಾದ", theme: "saffron" },
      platforms: ["facebook"],
    });
    const queue = await api().get("/api/ops/render-queue").set(secret());
    expect(queue.body.posts).toEqual([expect.objectContaining({ _id: String(post._id), headline: "ಎರಡು ಕುಟುಂಬಗಳು, ಒಂದು ಹೊಸ ಆರಂಭ", theme: "saffron" })]);

    imagekit.upload.mockResolvedValueOnce({ url: "https://ik.example.test/ops-posts/a.jpg", fileId: "f1" });
    const jpeg = Buffer.alloc(300000, 1).toString("base64"); // ~400 kB, above the default body limit
    const done = await api().post("/api/ops/render-done").set(secret()).send({ postId: String(post._id), jpeg });
    expect(done.status).toBe(200);
    const saved = await OpsPost.findById(post._id);
    expect(saved.status).toBe("planned");
    expect(saved.imageUrl).toBe("https://ik.example.test/ops-posts/a.jpg");
    expect(await OpsAction.exists({ type: "organic.schedule", "payload.postId": String(post._id) })).toBeTruthy();
    expect((await api().get("/api/ops/render-queue").set(secret())).body.posts).toEqual([]);

    // Facebook copies the image when the post is scheduled, so ours is deleted right after.
    const schedule = await OpsAction.findOne({ type: "organic.schedule", "payload.postId": String(post._id) });
    await execute(schedule._id);
    expect((await OpsAction.findById(schedule._id)).status).toBe("done");
    expect(imagekit.deleteFile).toHaveBeenCalledWith("f1");
    const after = await OpsPost.findById(post._id);
    expect(after.status).toBe("scheduled");
    expect(after.imageUrl).toBeUndefined();
    expect(after.imageDeletedAt).toBeInstanceOf(Date);
  });

  it("keeps Facebook and Instagram on one card", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.organic": "live" } }, { upsert: true });
    await OpsPost.deleteMany({});
    await OpsAction.deleteMany({});
    const post = await OpsPost.create({
      publishAt: new Date(Date.now() + 3 * 86400000),
      language: "Tamil",
      topic: "Why 351",
      caption: "caption",
      design: { headline: "h" },
      platforms: ["facebook", "instagram"],
      imageUrl: "https://ik.example.test/ops-posts/b.jpg",
      imageFileId: "f2",
      status: "planned",
    });
    const card = await OpsAction.create({ module: "organic", type: "organic.schedule", status: "scheduled", title: "Mon · Tamil: Why 351", runAt: new Date(), payload: { postId: String(post._id) }, ref: { kind: "post", id: String(post._id) } });
    await execute(card._id);
    const mid = await OpsAction.findById(card._id);
    expect(mid).toMatchObject({ type: "organic.publish_ig", status: "scheduled", title: "Mon · Tamil: Why 351" });
    expect(mid.effect).toMatch(/Facebook: scheduled/);
    expect(await OpsAction.countDocuments({ "payload.postId": String(post._id) })).toBe(1);
    await execute(card._id);
    const end = await OpsAction.findById(card._id);
    expect(end.error ?? "").toBe("");
    expect(end.status).toBe("done");
    expect((await OpsPost.findById(post._id)).status).toBe("published");
  });
});

describe("ad automation", () => {
  const admin = async () => tokenFor(await createUser({ rest: { isAdmin: true } }));

  it("waits for the images, then launches the new ads and pauses the weakest", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.ads": "live" } }, { upsert: true });
    const c = await OpsCreative.create({ campaignId: "c1", adsetId: "s1", language: "Kannada", baseAdId: "ad_best", replaceAdId: "ad_worst", design: { headline: "ಹೊಸ ಆರಂಭ" }, primaryText: "ಪಠ್ಯ", title: "ಶೀರ್ಷಿಕೆ" });
    const action = await OpsAction.create({
      module: "ads", type: "ads.creative_launch", status: "scheduled", title: "2 fresh ads", runAt: new Date(),
      payload: { campaignId: "c1", adsetId: "s1", creativeIds: [String(c._id)], baseAdId: "ad_best", replaceAdId: "ad_worst" },
    });

    await execute(action._id);
    let a = await OpsAction.findById(action._id);
    expect(a.status).toBe("scheduled");
    expect(a.runAt.getTime()).toBeGreaterThan(Date.now() + 3600000);

    await OpsCreative.updateOne({ _id: c._id }, { status: "ready", imageUrl: "https://ik.example.test/ad.jpg", imageFileId: "f_ad" });
    const realFetch = globalThis.fetch;
    const before = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(Buffer.from("jpeg-bytes")));
    try {
      await execute(action._id);
    } finally {
      globalThis.fetch = before;
    }
    a = await OpsAction.findById(action._id);
    expect(a.status).toBe("done");
    expect(a.result).toMatchObject({ adIds: ["ad_new"], paused: "ad_worst" });
    expect(metaCalls.setStatus).toHaveBeenCalledWith("ad_new", "ACTIVE");
    expect(metaCalls.setStatus).toHaveBeenCalledWith("ad_worst", "PAUSED");
    expect((await OpsCreative.findById(c._id)).status).toBe("live");

    metaCalls.setStatus.mockClear();
    const res = await api().post(`/api/manage/ops/actions/${action._id}/undo`).set("x-auth-token", await admin());
    expect(res.status).toBe(200);
    expect(metaCalls.setStatus).toHaveBeenCalledWith("ad_new", "PAUSED");
    expect(metaCalls.setStatus).toHaveBeenCalledWith("ad_worst", "ACTIVE");
    expect((await OpsAction.findById(action._id)).status).toBe("cancelled");
  });

  it("undoes a budget step by restoring the old budget", async () => {
    const a = await OpsAction.create({ module: "ads", type: "ads.budget", status: "done", title: "Raise", payload: { entityId: "c9", from: 2000, to: 2200 } });
    await api().post(`/api/manage/ops/actions/${a._id}/undo`).set("x-auth-token", await admin());
    expect(metaCalls.setDailyBudget).toHaveBeenCalledWith("c9", 2000);
  });

  it("refuses to undo something that hasn't run", async () => {
    const a = await OpsAction.create({ module: "ads", type: "ads.budget", status: "scheduled", title: "Raise", payload: {} });
    const res = await api().post(`/api/manage/ops/actions/${a._id}/undo`).set("x-auth-token", await admin());
    expect(res.status).toBe(409);
  });

  it("puts ad creatives in the render queue next to posts, with the ad card's fields", async () => {
    await OpsPost.deleteMany({});
    await OpsCreative.deleteMany({});
    await OpsCreative.create({ language: "Telugu", design: { headline: "కొత్త ప్రారంభం", highlight: "మీ కుటుంబం కోసం", bullets: ["ఒకటి", "రెండు", "మూడు"], price: "₹351", cta: "నమోదు", theme: "ad" } });
    const q = await api().get("/api/ops/render-queue").set({ "x-internal-secret": process.env.INTERNAL_ROUTE_SECRET });
    expect(q.body.posts).toEqual([
      expect.objectContaining({ kind: "ad", language: "Telugu", headline: "కొత్త ప్రారంభం", highlight: "మీ కుటుంబం కోసం", bullets: ["ఒకటి", "రెండు", "మూడు"], cta: "నమోదు" }),
    ]);
  });

  it("moves budget between languages (cut first) and undoes it", async () => {
    metaRead.structure = {
      campaigns: [
        { id: "c_te", name: "SRK | Telugu", dailyBudget: 2100, status: "ACTIVE" },
        { id: "c_kn", name: "SRK | Kannada", dailyBudget: 1700, status: "ACTIVE" },
      ],
      adsets: [],
    };
    metaCalls.setDailyBudget.mockClear();
    const a = await OpsAction.create({
      module: "ads", type: "ads.rebalance", status: "scheduled", title: "Move", runAt: new Date(),
      payload: { moves: [{ entityId: "c_te", name: "SRK | Telugu", from: 2100, to: 1800 }, { entityId: "c_kn", name: "SRK | Kannada", from: 1700, to: 2000 }] },
    });
    await execute(a._id);
    expect((await OpsAction.findById(a._id)).status).toBe("done");
    expect(metaCalls.setDailyBudget.mock.calls).toEqual([["c_te", 1800], ["c_kn", 2000]]);

    metaCalls.setDailyBudget.mockClear();
    await api().post(`/api/manage/ops/actions/${a._id}/undo`).set("x-auth-token", await admin());
    expect(metaCalls.setDailyBudget.mock.calls).toEqual([["c_kn", 1700], ["c_te", 2100]]);
  });

  it("skips a budget move when someone changed a budget in the meantime", async () => {
    metaRead.structure = { campaigns: [{ id: "c_te", name: "SRK | Telugu", dailyBudget: 2500, status: "ACTIVE" }, { id: "c_kn", name: "SRK | Kannada", dailyBudget: 1700, status: "ACTIVE" }], adsets: [] };
    metaCalls.setDailyBudget.mockClear();
    const a = await OpsAction.create({
      module: "ads", type: "ads.rebalance", status: "scheduled", title: "Move", runAt: new Date(),
      payload: { moves: [{ entityId: "c_te", name: "SRK | Telugu", from: 2100, to: 1800 }, { entityId: "c_kn", name: "SRK | Kannada", from: 1700, to: 2000 }] },
    });
    await execute(a._id);
    const after = await OpsAction.findById(a._id);
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/someone changed it/);
    expect(metaCalls.setDailyBudget).not.toHaveBeenCalled();
  });

  it("pauses a losing ad, but never the third-last one", async () => {
    metaCalls.setStatus.mockClear();
    metaRead.ads = ["a1", "a2", "a3"].map((id) => ({ id, name: id, adset_id: "s1", campaign_id: "c_te", effective_status: "ACTIVE" }));
    const pause = (adId) => OpsAction.create({ module: "ads", type: "ads.pause_ad", status: "scheduled", title: "Pause", runAt: new Date(), payload: { adId, adsetId: "s1", campaignId: "c_te" } });
    const first = await pause("a1");
    await execute(first._id);
    expect(metaCalls.setStatus).toHaveBeenCalledWith("a1", "PAUSED");

    metaRead.ads[0].effective_status = "PAUSED";
    const second = await pause("a2");
    await execute(second._id);
    expect((await OpsAction.findById(second._id)).error).toMatch(/Only 2 active ads/);
    metaRead.ads = null;
  });

  it("emails urgent alerts to the admins", async () => {
    const owner = await createUser({ rest: { isAdmin: true } });
    const { notice } = await import("../src/ops/actions.js");
    await notice("ads", { type: "ads.disapproved", priority: "urgent", title: "2 ads disapproved by Meta", reason: "KN-09: Personal attributes", effect: "Alert only.", payload: { dedupeKey: "t1" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: owner.basic.email });
    expect(sent[0].subject).toMatch(/^\[SRK Ops\] 2 ads disapproved/);
    // The same alert within a day isn't sent again.
    await notice("ads", { type: "ads.disapproved", priority: "urgent", title: "2 ads disapproved by Meta", reason: "x", effect: "x", payload: { dedupeKey: "t1" } });
    expect(sent).toHaveLength(1);
  });

  it("saves the ads rules from Settings", async () => {
    const res = await api()
      .post("/api/manage/ops/config")
      .set("x-auth-token", await admin())
      .send({ ads: { handsOffUntil: "2026-12-10", batchEveryDays: 21, newAdsets: true, alertEmail: "owner@example.com" }, organic: { planEvenings: true } });
    expect(res.status).toBe(200);
    expect(res.body.ads).toMatchObject({ batchEveryDays: 21, newAdsets: true, alertEmail: "owner@example.com", rebalance: true });
    expect(res.body.organic).toMatchObject({ planEvenings: true });
    expect(new Date(res.body.ads.handsOffUntil).toISOString().slice(0, 10)).toBe("2026-12-10");
    const bad = await api().post("/api/manage/ops/config").set("x-auth-token", await admin()).send({ ads: { alertEmail: "not an email" } });
    expect(bad.status).toBe(400);
  });

  it("plans no ad changes before the hands-off date", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.ads": "live", "ads.handsOffUntil": new Date(Date.now() + 5 * 86400000) } }, { upsert: true });
    const { runAdsPlanning } = await import("../src/ops/adsGrowth.js");
    const r = /** @type {any} */ (await runAdsPlanning());
    expect(r.skipped).toMatch(/Hands off until/);
    expect(await OpsAction.countDocuments({ type: { $in: ["ads.pause_ad", "ads.creative_launch", "ads.new_adset"] } })).toBe(0);
  });
});

describe("vendor alerts", () => {
  it("raises one urgent alert for Meta's WhatsApp-number-removed mails and ignores newsletters", async () => {
    const removed = (uid) =>
      mail(uid, "notification@facebookmail.com", "WhatsApp phone number removed from account. Your marketing messages can't be sent.", {
        subject: "Fix issue so that your marketing message can send",
        from: { email: "notification@facebookmail.com", name: "Meta for Business" },
      });
    inbox.push(removed(101), removed(102), removed(103));
    inbox.push(mail(104, "news@facebookmail.com", "Brands using partnership ads saw a 71% increase.", { subject: "Discover how partnership ads can grow your reach", from: { email: "news@facebookmail.com", name: "Meta for Business" } }));
    await runSupportCycle();
    const alerts = await OpsAction.find({ type: "support.vendor_alert" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].priority).toBe("urgent");
    expect(alerts[0].title).toMatch(/Fix issue/);
    expect(triage).not.toHaveBeenCalled();
  });
});

describe("profile change requests", () => {
  const goLive = () => OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.support": "live" } }, { upsert: true });

  it("corrects the date of birth after the notice period, replies, and can be undone", async () => {
    await goLive();
    const user = await createUser();
    const before = user.basic.dob.toISOString().slice(0, 10);
    triage.mockReturnValue({ category: "profile_change", language: "English", summary: "Wants DOB corrected", mobile: "", email: "", confidence: 0.9, changes: [{ field: "dob", value: "1985-11-05" }] });
    inbox.push(mail(201, user.basic.email, "Pls currect DOB 05/11/1985", { subject: "Pls currect DOB" }));
    await runSupportCycle();
    const a = await OpsAction.findOne({ type: "support.profile_change" });
    expect(a.status).toBe("scheduled");
    expect((a.runAt.getTime() - Date.now()) / 3600000).toBeGreaterThan(7.9);
    expect(a.effect).toContain(`${before} → 1985-11-05`);

    await execute(a._id);
    expect((await User.findById(user._id)).basic.dob.toISOString().slice(0, 10)).toBe("1985-11-05");
    expect(sent.at(-1).to).toBe(user.basic.email);

    const admin = await createUser({ rest: { isAdmin: true } });
    const res = await api().post(`/api/manage/ops/actions/${a._id}/undo`).set("x-auth-token", tokenFor(admin));
    expect(res.status).toBe(200);
    expect((await User.findById(user._id)).basic.dob.toISOString().slice(0, 10)).toBe(before);
  });

  it("sends pick-list fields to the admin instead of changing them", async () => {
    await goLive();
    const user = await createUser();
    triage.mockReturnValue({ category: "profile_change", language: "English", summary: "Change qualification", mobile: "", email: "", confidence: 0.9, changes: [{ field: "qualification", value: "M.Tech" }] });
    inbox.push(mail(202, user.basic.email, "Please change my qualification to M.Tech"));
    await runSupportCycle();
    expect(await OpsAction.exists({ type: "support.profile_change" })).toBeNull();
    const card = await OpsAction.findOne({ status: "needs_you" });
    expect(card.reason).toContain("qualification → M.Tech");
    expect((await User.findById(user._id)).basic.qualification).toBe("B.E");
  });

  it("never changes a profile for an unmatched sender", async () => {
    await goLive();
    const user = await createUser();
    triage.mockReturnValue({ category: "profile_change", language: "English", summary: "Change name", mobile: "", email: user.basic.email, confidence: 0.9, changes: [{ field: "fullName", value: "Someone Else" }] });
    inbox.push(mail(203, "stranger@example.test", `Change name on ${user.basic.email}`));
    await runSupportCycle();
    expect(await OpsAction.exists({ type: "support.profile_change" })).toBeNull();
    expect((await OpsAction.findOne({ status: "needs_you" })).title).toMatch(/can't match/);
    expect((await User.findById(user._id)).basic.fullName).toBe(user.basic.fullName);
  });

  it("rejects an impossible date of birth", async () => {
    const { cleanChange } = await import("../src/ops/support.js");
    expect(cleanChange("dob", "2015-01-01")).toBeNull();
    expect(cleanChange("dob", "1985-11-05")).toBeInstanceOf(Date);
    expect(cleanChange("email", "x@y.z")).toBeNull();
  });
});

describe("activity log", () => {
  it("lists every action with filters, search and paging", async () => {
    await OpsAction.deleteMany({});
    await OpsAction.create([
      { module: "support", type: "support.reply", status: "done", title: "Reply to Ramesh (+91 98450)", reason: "OTP" },
      { module: "support", type: "support.refund", status: "needs_you", title: "Refund request from Lakshmi" },
      { module: "ads", type: "ads.budget", status: "cancelled", title: "Raise SRK | Kannada", decidedBy: "U0001" },
      { module: "comments", type: "comments.delete", status: "failed", title: "Delete hidden comment", error: "Meta said no" },
    ]);
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const get = (qs) => api().get(`/api/manage/ops/activity${qs}`).set("x-auth-token", token);

    const all = await get("");
    expect(all.body.total).toBe(4);
    expect(all.body.byStatus).toMatchObject({ done: 1, needs_you: 1, cancelled: 1, failed: 1 });
    expect((await get("?module=support")).body.total).toBe(2);
    expect((await get("?status=failed,cancelled")).body.items.map((a) => a.module).sort()).toEqual(["ads", "comments"]);
    expect((await get("?q=lakshmi")).body.items[0].title).toMatch(/Lakshmi/);
    expect((await get("?q=%2B91")).body.total).toBe(1); // "+" is treated literally
    expect((await get("?q=U0001")).body.total).toBe(1); // who decided
    const paged = await get("?limit=5&page=2");
    expect(paged.body.items).toHaveLength(0);
    expect(paged.body.pages).toBe(1);
  });
});

describe("plan an idea", () => {
  const empty = { post: { topic: "", kicker: "", headline: "", subline: "", theme: "", caption: "" }, ad: { campaignId: "", adsetId: "", variants: [] }, adset: { campaignId: "", baseAdsetId: "", name: "", locations: [], ageMin: 0, ageMax: 0, gender: "all", dailyBudget: 0 }, budget: { entityId: "", dailyBudget: 0 } };
  const future = (days) => new Date(Date.now() + days * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

  beforeEach(async () => {
    const { AdSnapshot } = await import("../src/ops/models.js");
    await AdSnapshot.deleteMany({});
    await AdSnapshot.create([
      { level: "campaign", entityId: "c_kn", name: "SRK | Kannada", date: "2026-11-25", dailyBudget: 2000, status: "ACTIVE" },
      { level: "campaign", entityId: "c_te", name: "SRK | Telugu", date: "2026-11-25", dailyBudget: 2200, status: "ACTIVE" },
    ]);
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.ads": "live", "modes.organic": "live", "limits.maxDailySpend": 10000 } }, { upsert: true });
    await OpsPost.deleteMany({});
  });

  it("turns an idea into scheduled steps and flags what it can't do", async () => {
    ideaPlan.mockReturnValue({
      title: "Diwali push",
      steps: [
        { ...empty, kind: "organic_post", date: future(3), summary: "Kannada Diwali post", language: "Kannada", post: { topic: "Diwali", kicker: "ದೀಪಾವಳಿ", headline: "ಬೆಳಕಿನ ಹಬ್ಬದ ಶುಭಾಶಯಗಳು", subline: "ಕುಟುಂಬದೊಂದಿಗೆ", theme: "maroon", caption: "ಶುಭಾಶಯಗಳು seetharamakalyana.in" } },
        { ...empty, kind: "budget", date: future(1), summary: "Raise Kannada for Diwali", language: "Kannada", budget: { entityId: "c_kn", dailyBudget: 2300 } },
        { ...empty, kind: "budget", date: future(1), summary: "Huge Telugu raise", language: "Telugu", budget: { entityId: "c_te", dailyBudget: 9000 } },
        { ...empty, kind: "unsupported", date: future(1), summary: "Send a WhatsApp broadcast to all members", language: "English" },
        { ...empty, kind: "ad_creatives", date: future(2), summary: "Diwali ads in Kannada", language: "Kannada", ad: { campaignId: "c_kn", adsetId: "", variants: [{ kicker: "ದೀಪಾವಳಿ", headline: "ಹಬ್ಬದ ಹೊಸ ಆರಂಭ", subline: "ಕುಟುಂಬದ ಆಶೀರ್ವಾದ", theme: "saffron", primaryText: "ಪಠ್ಯ", title: "ಶೀರ್ಷಿಕೆ" }] } },
      ],
    });
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const res = await api().post("/api/manage/ops/ideas").set("x-auth-token", token).send({ text: "Diwali push: posts and a small Kannada budget raise" });
    expect(res.status).toBe(200);
    expect(res.body.steps.map((s) => s.status)).toEqual(["planned", "scheduled", "needs_you", "needs_you", "scheduled"]);

    const post = await OpsPost.findOne({ topic: "Diwali" });
    expect(post.status).toBe("design");
    expect(post.design.headline).toBe("ಬೆಳಕಿನ ಹಬ್ಬದ ಶುಭಾಶಯಗಳು");

    const budget = await OpsAction.findOne({ type: "ads.budget", "payload.entityId": "c_kn" });
    expect(budget.payload).toMatchObject({ from: 2000, to: 2300 });
    expect(budget.runAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600000);

    const launch = await OpsAction.findOne({ type: "ads.creative_launch", "payload.ideaId": res.body.ideaId });
    expect(launch.payload.replaceAdId).toBeNull();

    expect(await OpsAction.countDocuments({ type: "ops.note", status: "needs_you", "payload.ideaId": res.body.ideaId })).toBe(2);
    const idea = await OpsAction.findById(res.body.ideaId);
    expect(idea.type).toBe("ops.idea");
    expect(idea.effect).toBe("3 of 5 step(s) scheduled");
  });

  it("plans review ideas nobody acted on for 48 hours", async () => {
    const { autoPlanIdeas } = await import("../src/ops/ideas.js");
    const old = await OpsAction.create({ module: "ads", type: "ops.note", status: "idea", title: "Test pricing creative", reason: "Telugu costs are high", createdAt: new Date(Date.now() - 3 * 86400000) });
    await OpsAction.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 3 * 86400000) } });
    ideaPlan.mockReturnValue({ title: "Pricing creative", steps: [{ ...empty, kind: "unsupported", date: future(1), summary: "Needs a video", language: "English" }] });
    const r = await autoPlanIdeas();
    expect(r.planned).toBe(1);
    const after = await OpsAction.findById(old._id);
    expect(after.status).toBe("done");
    expect(after.decidedBy).toMatch(/no answer in 48 h/);
  });

  it("leaves fresh ideas alone", async () => {
    const { autoPlanIdeas } = await import("../src/ops/ideas.js");
    await OpsAction.deleteMany({ status: "idea" });
    await OpsAction.create({ module: "ads", type: "ops.note", status: "idea", title: "Fresh idea" });
    expect((await autoPlanIdeas()).planned).toBe(0);
  });
});

describe("automation (Vercel Cron)", () => {
  const cronTick = () =>
    api().post("/api/ops/tick").set({ "x-internal-secret": process.env.INTERNAL_ROUTE_SECRET, "user-agent": "vercel-cron/1.0 (+https://vercel.com/docs/cron-jobs)" });

  it("never creates a QStash schedule; the first Vercel Cron tick removes the old one, once", async () => {
    // Vercel Cron authenticates with CRON_SECRET (set in production).
    process.env.CRON_SECRET ??= "cron-test";
    qstashCalls.length = 0;
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    await api().get("/api/manage/ops/overview").set("x-auth-token", token);
    expect(qstashCalls).toHaveLength(0);

    expect((await cronTick()).status).toBe(200);
    expect(qstashCalls).toEqual([expect.objectContaining({ method: "DELETE", url: expect.stringMatching(/schedules\/ops-tick$/) })]);
    await cronTick();
    expect(qstashCalls).toHaveLength(1);

    const o = await api().get("/api/manage/ops/overview").set("x-auth-token", token);
    expect(o.body.automation).toMatchObject({ ready: true, healthy: true, source: "vercel" });
  });

  it("runs one tick at a time", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { tickLockUntil: new Date(Date.now() + 60000) } }, { upsert: true });
    const r = await cronTick();
    expect(r.body.ran).toEqual([expect.objectContaining({ result: "Another run is in progress" })]);
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { tickLockUntil: null } });
  });

  it("raises an urgent alert after missed runs", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "lastRuns.tick": { at: new Date(Date.now() - 3 * 3600000), ok: true } } }, { upsert: true });
    await cronTick();
    const a = await OpsAction.findOne({ type: "ops.missed_runs" });
    expect(a).toMatchObject({ priority: "urgent" });
    expect(a.title).toMatch(/last one was 3 h/);
  });

  it("lets an admin run it now", async () => {
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const r = await api().post("/api/manage/ops/automation/start").set("x-auth-token", token);
    expect(r.status).toBe(200);
    expect(r.body.msg).toMatch(/Ran|problem/);
  });
});

describe("render pass", () => {
  it("lets the render Action in with a fresh pass and refuses forged or expired ones", async () => {
    const { signRenderToken, verifyRenderToken } = await import("../src/ops/renderToken.js");
    const good = signRenderToken();
    expect(verifyRenderToken(good)).toBe(true);
    expect(verifyRenderToken(signRenderToken(Date.now() - 4 * 3600_000))).toBe(false);
    expect(verifyRenderToken(`${Date.now() + 1000}.deadbeef`)).toBe(false);
    expect((await api().get("/api/ops/render-queue").set("x-render-token", good)).status).toBe(200);
    expect((await api().get("/api/ops/render-queue").set("x-render-token", "nope")).status).toBe(401);
  });
});

describe("organic planner", () => {
  /** Next Monday (IST) as YYYY-MM-DD, and an IST time on a day after it. */
  const nextMondayKey = () => {
    const ist = new Date(Date.now() + 5.5 * 3600000);
    const add = ((8 - ist.getUTCDay()) % 7) || 7;
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add)).toISOString().slice(0, 10);
  };
  const istAt = (dayKey, plusDays, hour) => new Date(Date.parse(dayKey) + plusDays * 86400000 + (hour - 5.5) * 3600000);
  const planned = (day, extra = {}) => ({
    day, language: "Kannada", idea: "community", format: "card", angle: "Community", topic: `Topic ${day}`, kicker: "k", headline: `h${day}`, subline: "s",
    highlight: "", bullets: [], price: "", cta: "ಇಂದೇ ನೋಂದಾಯಿಸಿ", caption: "ನಿಮ್ಮ ಮಗಳಿಗೆ ಸರಿಯಾದ ಸಂಬಂಧ?", hashtags: ["KannadaMatrimony", "#Bengaluru"], theme: "saffron", ...extra,
  });

  it("fills only free evenings, learns from sign-ups, and caps join posts at 1 in 3", async () => {
    const { planWeek } = await import("../src/ops/organic.js");
    const { ask } = await import("../src/ops/claude.js");
    await OpsPost.deleteMany({});
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.organic": "live", "organic.planEvenings": true } }, { upsert: true });
    const monday = nextMondayKey();
    // Wednesday evening is taken by hand; Tuesday only has a 12:30 safety post, so its evening is free.
    metaRead.scheduledTimes = [istAt(monday, 2, 19.5), istAt(monday, 1, 12.5)];
    metaRead.performance = [
      { platform: "facebook", at: "2026-11-20", text: "ಕುಟುಂಬದ ಆಶೀರ್ವಾದ https://www.seetharamakalyana.in/kn?p=fkn1120", code: "fkn1120", reach: 900, engagement: 81, linkClicks: 40 },
      { platform: "instagram", at: "2026-11-21", text: "Why join", code: null, reach: 400, engagement: 4, profileVisits: 9 },
    ];
    await createUser({ rest: { acquisition: { utmSource: "facebook", utmMedium: "organic", utmContent: "fkn1120" } } });
    await createUser({ rest: { acquisition: { utmSource: "facebook", utmMedium: "organic", utmContent: "fkn1120" } } });
    organicPlan.mockReturnValue({ posts: [0, 1, 2, 3, 4, 5, 6].map((d) => planned(d, d < 4 ? { format: "join", highlight: "ಟೈಮ್‌ಪಾಸ್ ಅಲ್ಲ", bullets: ["a", "b", "c"], price: "₹351" } : {})) });

    await (await import("../src/ops/models.js")).OpsComment.create({ platform: "facebook", commentId: "c_q1", text: "Is this site real? How do I see contact numbers?", category: "question", createdAt: new Date() });
    // The quality check drops one post (a false claim it can't fix) and fixes another.
    organicReview.mockReturnValueOnce({
      reviews: [
        { index: 0, claimsOk: false, languageOk: true, problems: ["Promises a match"], fixed: null },
        { index: 1, claimsOk: true, languageOk: false, problems: ["Literal translation"], fixed: { kicker: "k", headline: "ಸರಿಯಾದ ಸಾಲು", subline: "s", highlight: "", bullets: [], price: "", cta: "ನೋಂದಾಯಿಸಿ", caption: "ಸರಿಪಡಿಸಿದ" } },
      ],
    });

    const r = await planWeek();
    expect(r).toMatchObject({ planned: 5, dropped: 1, skippedDays: 1, learnedFrom: 2 });
    const posts = await OpsPost.find().sort({ publishAt: 1 }).lean();
    const days = posts.map((p) => new Date(p.publishAt.getTime() + 5.5 * 3600000).toISOString().slice(0, 10));
    expect(days).not.toContain(new Date(Date.parse(monday) + 2 * 86400000).toISOString().slice(0, 10));
    expect(posts.filter((p) => p.format === "join").length).toBeLessThanOrEqual(2);
    expect(posts.every((p) => p.idea === "community")).toBe(true);
    expect(posts.find((p) => p.design?.headline === "ಸರಿಯಾದ ಸಾಲು")?.review).toMatch(/Fixed by the check/);
    // Every post at 7:30 pm IST with a tracking code for its language and date.
    for (const p of posts) {
      const t = new Date(p.publishAt.getTime() + 5.5 * 3600000);
      expect([t.getUTCHours(), t.getUTCMinutes()]).toEqual([19, 30]);
      expect(p.code).toMatch(/^(kn|te|ta|hi|en)\d{4}$/);
    }
    // The five languages take turns.
    expect(new Set(posts.map((p) => p.language)).size).toBeGreaterThanOrEqual(4);
    const call = ask.mock.calls.findLast(([o]) => o.task === "organic.plan")[0];
    expect(call.prompt).toMatch(/Plan exactly 6 post/);
    expect(call.prompt).toMatch(/2 sign-ups traced/);
    expect(call.prompt).toMatch(/2 sign-ups, reach 900, engagement 81, link clicks 40/);
    expect(call.system).toMatch(/At most 2 this week/);
    expect(call.system).toMatch(/answer \(Answer a family's doubt\)/);
    expect(call.prompt).toMatch(/Is this site real\? How do I see contact numbers\?/);
  });

  it("writes the Facebook caption with a tracked link and the Instagram one with link in bio", async () => {
    const { captionFor } = await import("../src/ops/organic.js");
    const p = { language: "Telugu", code: "te1201", caption: "మీ కుటుంబానికి సరైన సంబంధం?", cta: "ఇప్పుడే నమోదు చేసుకోండి", hashtags: ["TeluguMatrimony", "Hyderabad", "Vizag", "Brahmin"] };
    const fb = captionFor(p, "facebook");
    expect(fb).toContain("ఇప్పుడే నమోదు చేసుకోండి: https://www.seetharamakalyana.in/te?p=fte1201");
    expect(fb).toContain("#TeluguMatrimony #Hyderabad #Vizag");
    expect(fb).not.toContain("#Brahmin");
    const ig = captionFor(p, "instagram");
    expect(ig).toContain("seetharamakalyana.in/te (link in bio)");
    expect(ig).toContain("#Brahmin");
    // Older posts keep their own caption.
    expect(captionFor({ caption: "old caption seetharamakalyana.in" }, "facebook")).toBe("old caption seetharamakalyana.in");
  });

  it("draws join posts in the ad layout with the language's address", async () => {
    await OpsPost.deleteMany({});
    await OpsCreative.deleteMany({});
    await OpsPost.create({ publishAt: new Date(Date.now() + 86400000), language: "Tamil", format: "join", topic: "Why 351", caption: "c", design: { headline: "ஏனெனில் திருமணம்", highlight: "டைம்பாஸ் அல்ல", bullets: ["a"], cta: "பதிவு", theme: "ad" }, status: "design" });
    await OpsPost.create({ publishAt: new Date(Date.now() + 2 * 86400000), language: "English", topic: "How it works", caption: "c", design: { headline: "Three steps" }, status: "design" });
    const q = await api().get("/api/ops/render-queue").set({ "x-internal-secret": process.env.INTERNAL_ROUTE_SECRET });
    expect(q.body.posts).toEqual([
      expect.objectContaining({ kind: "ad", language: "Tamil", url: "seetharamakalyana.in/ta", highlight: "டைம்பாஸ் அல்ல" }),
      expect.objectContaining({ kind: "post", language: "English", url: "seetharamakalyana.in" }),
    ]);
  });

  it("counts sign-ups per post code for the Organic screen", async () => {
    await createUser({ rest: { acquisition: { utmSource: "instagram", utmMedium: "organic", utmContent: "bio" } } });
    await createUser({ rest: { acquisition: { utmSource: "meta", utmMedium: "paid", utmContent: "kn_why351" } } });
    const res = await api().get("/api/manage/ops/organic").set("x-auth-token", await tokenFor(await createUser({ rest: { isAdmin: true } })));
    expect(res.status).toBe(200);
    expect(res.body.signups).toMatchObject({ bio: 1 });
    expect(res.body.signups.kn_why351).toBeUndefined();
  });
});

describe("ad idea engine", () => {
  const variant = (role, idea, extra = {}) => ({
    idea, role, angle: `${role} angle`, kicker: "ಪಿಲ್", headline: "ಸಾಲು", highlight: "ಪಂಚ್", bullets: ["a", "b", "c"], price: "₹351", cta: "ನೋಂದಾಯಿಸಿ",
    primaryText: "ಪಠ್ಯ", title: "ಶೀರ್ಷಿಕೆ", translation: "English version", ...extra,
  });

  it("writes one proven and one test variant from the library, images and families' questions, and drops what fails the check", async () => {
    const { AdSnapshot, OpsComment } = await import("../src/ops/models.js");
    const { planCreativeRefresh } = await import("../src/ops/adsCreative.js");
    const { ask } = await import("../src/ops/claude.js");
    await Promise.all([AdSnapshot.deleteMany({}), OpsCreative.deleteMany({}), OpsComment.deleteMany({})]);
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.ads": "live" } }, { upsert: true });
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    await AdSnapshot.create([
      { level: "adset", entityId: "s_kn", name: "Kannada | Karnataka | Parents 45-65", campaignId: "c_kn", date: day },
      { level: "ad", entityId: "ad_kn1", name: "KN-07 Parents Communities 2", campaignName: "SRK | Kannada", campaignId: "c_kn", adsetId: "s_kn", date: day, spend: 4000, paid: 22 },
      { level: "ad", entityId: "ad_kn2", name: "KN-09 Parents Why 351", campaignName: "SRK | Kannada", campaignId: "c_kn", adsetId: "s_kn", date: day, spend: 4000, paid: 12 },
    ]);
    await OpsComment.create({ platform: "facebook", commentId: "c_doubt", text: "Contact number plz, not able to register 9876543210", category: "question", createdAt: new Date() });
    metaRead.ads = [
      { id: "ad_kn1", name: "KN-07 Parents Communities 2", adset_id: "s_kn", campaign_id: "c_kn", effective_status: "ACTIVE" },
      { id: "ad_kn2", name: "KN-09 Parents Why 351", adset_id: "s_kn", campaign_id: "c_kn", effective_status: "ACTIVE" },
    ];
    adsWrite.mockReturnValue({ variants: [variant("proven", "community"), variant("test", "horoscope", { bullets: ["100% verified profiles", "b", "c"] })] });
    adsReview.mockReturnValue({
      reviews: [
        { index: 0, claimsOk: true, languageOk: true, problems: [], fixed: null },
        { index: 1, claimsOk: false, languageOk: true, problems: ["Says 100% verified"], fixed: null },
      ],
    });

    const r = await planCreativeRefresh({ campaignId: "c_kn", campaignName: "SRK | Kannada", adsetId: "s_kn", adsetName: "Kannada | Karnataka | Parents 45-65", notes: ["Tired."], runAt: new Date(Date.now() + 86400000) });
    expect(r).toMatchObject({ creatives: 1, ideas: ["proven:community"] });
    const call = ask.mock.calls.findLast(([o]) => o.task === "ads.creatives")[0];
    expect(call.images).toHaveLength(2);
    expect(call.prompt).toMatch(/Proven idea for this language and audience: community/);
    expect(call.prompt).toMatch(/Contact number plz, not able to register \[number\]/);
    expect(call.prompt).not.toContain("9876543210");
    const saved = await OpsCreative.find().lean();
    expect(saved).toEqual([expect.objectContaining({ idea: "community", role: "proven", review: expect.stringMatching(/Passed/) })]);
    const action = await OpsAction.findOne({ type: "ads.creative_launch" });
    expect(action.reason).toMatch(/dropped 1 variant/);
    expect(action.reason).toMatch(/Proven idea: Your community/);
    metaRead.ads = null;
  });

  it("judges a new ad against its ad set after 7 days", async () => {
    const { AdSnapshot } = await import("../src/ops/models.js");
    const { judgeNewAds } = await import("../src/ops/adsIdeas.js");
    await Promise.all([AdSnapshot.deleteMany({}), OpsCreative.deleteMany({})]);
    const liveAt = new Date(Date.now() - 8 * 86400000);
    await OpsCreative.create({ campaignName: "SRK | Kannada", adsetId: "s_kn", adId: "ad_new", status: "live", liveAt, idea: "horoscope", role: "test", design: { headline: "h" } });
    const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    await AdSnapshot.create([
      { level: "ad", entityId: "ad_new", date: day, spend: 2000, paid: 10 },
      { level: "adset", entityId: "s_kn", date: day, spend: 9000, paid: 30 },
    ]);
    const judged = await judgeNewAds();
    expect(judged).toEqual([expect.objectContaining({ verdict: "win" })]);
    expect((await OpsCreative.findOne({ adId: "ad_new" })).verdict).toBe("win");
    expect(await judgeNewAds()).toHaveLength(0);
  });
});

describe("stored brief fix", () => {
  it("corrects the two wrong sentences once and keeps the owner's other edits", async () => {
    const { getConfig } = await import("../src/ops/models.js");
    await OpsConfig.create({
      _id: "ops",
      brief: "Owner's own line.\n- Joining costs ₹351 (one time). Paid members get credits.\n- Profiles are checked by our team before they get the verified badge.",
    });
    const c = await getConfig();
    expect(c.brief).toContain("Owner's own line.");
    expect(c.brief).toContain("Membership costs ₹351 a year (annual).");
    expect(c.brief).toContain("confirmed by OTP");
    expect(c.brief).not.toMatch(/one time|checked by our team/);
    // Later edits by the owner aren't touched again.
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { brief: "Joining costs ₹351 (one time)." } });
    expect((await getConfig()).brief).toBe("Joining costs ₹351 (one time).");
  });
});

describe("stuck images and re-planning", () => {
  it("marks posts whose image failed 3 times as failed and alerts once", async () => {
    const { requestRenders } = await import("../src/ops/organic.js");
    await OpsPost.deleteMany({});
    await OpsCreative.deleteMany({});
    await OpsPost.create({ publishAt: new Date(Date.now() + 3 * 86400000), language: "Tamil", topic: "t", caption: "c", design: { headline: "h" }, status: "design", renderRequests: 3, renderRequestedAt: new Date(Date.now() - 3 * 3600000) });
    await requestRenders();
    expect((await OpsPost.findOne()).status).toBe("failed");
    expect(await OpsAction.countDocuments({ type: "organic.render_failed", priority: "urgent" })).toBe(1);
  });

  it("re-plans next week: replaces posts still waiting for images, keeps scheduled ones", async () => {
    await OpsPost.deleteMany({});
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.organic": "live", "organic.planEvenings": true } }, { upsert: true });
    metaRead.scheduledTimes = [];
    metaRead.performance = [];
    const ist = new Date(Date.now() + 5.5 * 3600000);
    const add = ((8 - ist.getUTCDay()) % 7) || 7;
    const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add) - 5.5 * 3600000);
    const at = (d) => new Date(monday.getTime() + d * 86400000 + 19.5 * 3600000);
    await OpsPost.create([
      { publishAt: at(0), language: "Kannada", topic: "old", caption: "c", design: { headline: "h" }, status: "design" },
      { publishAt: at(1), language: "Telugu", topic: "kept", caption: "c", design: { headline: "h" }, status: "scheduled" },
    ]);
    organicPlan.mockReturnValue({
      posts: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, language: "Kannada", idea: "how_it_works", format: "card", angle: "a", topic: `new ${day}`, kicker: "k", headline: "h", subline: "s", highlight: "", bullets: [], price: "", cta: "c", caption: "c", hashtags: ["x"], theme: "saffron" })),
    });
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const r = await api().post("/api/manage/ops/organic/replan").set("x-auth-token", token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cancelled: 1, planned: 6 });
    expect(await OpsPost.countDocuments({ topic: "kept", status: "scheduled" })).toBe(1);
    expect(await OpsPost.countDocuments({ topic: "old", status: "cancelled" })).toBe(1);
  });
});

describe("agent-planned ideas follow the ads rules", () => {
  const empty = { post: { topic: "", kicker: "", headline: "", subline: "", theme: "", caption: "" }, ad: { campaignId: "", adsetId: "", variants: [] }, adset: { campaignId: "c_kn", baseAdsetId: "", name: "Kannada | Mysuru | Parents", locations: ["Mysuru"], ageMin: 45, ageMax: 65, gender: "all", dailyBudget: 500 }, budget: { entityId: "", dailyBudget: 0 } };
  const future = (days) => new Date(Date.now() + days * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

  it("doesn't create ad sets, starve a language or make big jumps on its own", async () => {
    const { AdSnapshot } = await import("../src/ops/models.js");
    const { planIdea } = await import("../src/ops/ideas.js");
    await AdSnapshot.deleteMany({});
    await AdSnapshot.create([
      { level: "campaign", entityId: "c_kn", name: "SRK | Kannada", date: "2026-11-25", dailyBudget: 2000, status: "ACTIVE" },
      { level: "campaign", entityId: "c_te", name: "SRK | Telugu", date: "2026-11-25", dailyBudget: 2200, status: "ACTIVE" },
    ]);
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.ads": "live", "ads.newAdsets": false } }, { upsert: true });
    ideaPlan.mockReturnValue({
      title: "Review idea",
      steps: [
        { ...empty, kind: "new_adset", date: future(2), summary: "Mysuru parents", language: "Kannada" },
        { ...empty, kind: "budget", date: future(1), summary: "Cut Telugu hard", language: "Telugu", budget: { entityId: "c_te", dailyBudget: 300 } },
        { ...empty, kind: "budget", date: future(1), summary: "Raise Kannada 50%", language: "Kannada", budget: { entityId: "c_kn", dailyBudget: 3000 } },
        { ...empty, kind: "budget", date: future(1), summary: "Raise Kannada 10%", language: "Kannada", budget: { entityId: "c_kn", dailyBudget: 2200 } },
      ],
    });
    const r = await planIdea({ text: "Expand Kannada and trim Telugu", source: "review" });
    expect(r.steps.map((s) => s.status)).toEqual(["needs_you", "needs_you", "needs_you", "scheduled"]);
    expect(r.steps[0].error).toMatch(/New ad sets are switched off/);
    expect(r.steps[1].error).toMatch(/below ₹500/);
    expect(r.steps[2].error).toMatch(/over 20%/);
  });

  it("emails the owner when an ad change fails", async () => {
    await createUser({ rest: { isAdmin: true } });
    metaRead.structure = { campaigns: [], adsets: [] };
    const a = await OpsAction.create({ module: "ads", type: "ads.budget", status: "scheduled", title: "Raise SRK | Kannada to ₹2,200/day", runAt: new Date(), payload: { entityId: "gone", from: 2000, to: 2200 } });
    await execute(a._id);
    expect((await OpsAction.findById(a._id)).status).toBe("failed");
    const alert = await OpsAction.findOne({ type: "ads.action_failed" });
    expect(alert).toMatchObject({ priority: "urgent" });
    expect(sent.at(-1).subject).toMatch(/\[SRK Ops\] Failed: Raise SRK \| Kannada/);
  });
});

describe("no double posts", () => {
  it("doesn't plan evening posts unless the owner turns it on", async () => {
    const { planWeek } = await import("../src/ops/organic.js");
    await OpsPost.deleteMany({});
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.organic": "live", "organic.planEvenings": false } }, { upsert: true });
    const r = await planWeek();
    expect(r.skipped).toMatch(/organic posts are off/);
    expect(await OpsPost.countDocuments()).toBe(0);
  });

  it("plans nothing when Facebook's schedule can't be read", async () => {
    const { planWeek } = await import("../src/ops/organic.js");
    const meta = await import("../src/ops/meta.js");
    await OpsPost.deleteMany({});
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.organic": "live", "organic.planEvenings": true } }, { upsert: true });
    meta.fetchScheduledTimes.mockRejectedValueOnce(new Error("(#200) permission"));
    const r = await planWeek();
    expect(r.skipped).toMatch(/couldn't be read/);
    expect(await OpsPost.countDocuments()).toBe(0);
    expect(await OpsAction.countDocuments({ type: "organic.schedule_unreadable", priority: "urgent" })).toBe(1);
  });

  it("cancelling a scheduled post also removes it from Facebook", async () => {
    await OpsPost.deleteMany({});
    metaCalls.deleteFacebookPost.mockClear();
    const post = await OpsPost.create({ publishAt: new Date(Date.now() + 5 * 86400000), language: "Tamil", topic: "t", caption: "c", design: { headline: "h" }, status: "scheduled", results: { facebookId: "fb_123" } });
    const ig = await OpsAction.create({ module: "organic", type: "organic.publish_ig", status: "scheduled", title: "IG", runAt: post.publishAt, ref: { kind: "post-ig", id: String(post._id) } });
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const r = await api().post(`/api/manage/ops/actions/${ig._id}/cancel`).set("x-auth-token", token);
    expect(r.body.msg).toBe("Cancelled and removed from Facebook");
    expect(metaCalls.deleteFacebookPost).toHaveBeenCalledWith("fb_123");
    expect((await OpsPost.findById(post._id)).status).toBe("cancelled");
    expect((await OpsPost.findById(post._id)).results.facebookRemovedAt).toBeTruthy();
  });

  it("the sweep removes posts cancelled earlier, and gives up with an alert after 3 tries", async () => {
    const { sweepCancelled } = await import("../src/ops/organic.js");
    await OpsPost.deleteMany({});
    metaCalls.deleteFacebookPost.mockClear();
    const later = new Date(Date.now() + 3 * 86400000);
    const base = { publishAt: later, language: "Tamil", topic: "t", caption: "c", design: { headline: "h" }, status: "cancelled" };
    const a = await OpsPost.create({ ...base, results: { facebookId: "fb_a" } });
    await OpsPost.create({ ...base, results: { facebookId: "fb_done", facebookRemovedAt: new Date() } });
    await OpsPost.create({ ...base, publishAt: new Date(Date.now() - 3600000), results: { facebookId: "fb_past" } });
    expect(await sweepCancelled()).toBe(1);
    expect(metaCalls.deleteFacebookPost).toHaveBeenCalledTimes(1);
    expect(metaCalls.deleteFacebookPost).toHaveBeenCalledWith("fb_a");
    expect((await OpsPost.findById(a._id)).results.facebookRemovedAt).toBeTruthy();

    // Already deleted by hand: counts as removed.
    const gone = await OpsPost.create({ ...base, results: { facebookId: "fb_gone" } });
    metaCalls.deleteFacebookPost.mockRejectedValueOnce(new Error("Unsupported delete request. Object with ID 'fb_gone' does not exist"));
    expect(await sweepCancelled()).toBe(1);
    expect((await OpsPost.findById(gone._id)).results.facebookRemovedAt).toBeTruthy();

    // Keeps failing: three tries, then one urgent alert and no more tries.
    const stuck = await OpsPost.create({ ...base, results: { facebookId: "fb_stuck" } });
    metaCalls.deleteFacebookPost.mockRejectedValue(new Error("(#200) permission"));
    for (let i = 0; i < 4; i++) await sweepCancelled();
    metaCalls.deleteFacebookPost.mockReset();
    metaCalls.deleteFacebookPost.mockImplementation(async () => ({ success: true }));
    expect((await OpsPost.findById(stuck._id)).results.facebookRemoveTries).toBe(3);
    expect(await OpsAction.countDocuments({ type: "organic.unschedule_failed", priority: "urgent" })).toBe(1);
  });
});

describe("stories", () => {
  it("matches live stories to the planned ones and ranks concepts", async () => {
    const { recordStoryStats } = await import("../src/ops/organic.js");
    const { OpsStory } = await import("../src/ops/models.js");
    await OpsStory.deleteMany({});
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const day1 = new Date("2026-12-01T03:00:00Z"); // 8:30 am IST
    const day2 = new Date("2026-12-02T03:00:00Z");
    const saved = await api()
      .post("/api/manage/ops/organic/stories")
      .set("x-auth-token", token)
      .send({ stories: [{ at: day1, language: "Tamil", concept: "why351" }, { at: day2, language: "Hindi", concept: "daughters" }, { at: "nonsense" }] });
    expect(saved.body.saved).toBe(2);

    metaRead.stories = [
      { igId: "st1", at: new Date(day1.getTime() + 60000), reach: 200, replies: 2, shares: 0, profileVisits: 8, follows: 1, navigation: { forward: 120, back: 4, exited: 40, nextStory: 10 } },
      { igId: "st2", at: new Date(day2.getTime() + 120000), reach: 100, replies: 0, shares: 0, profileVisits: 1, follows: 0, navigation: { forward: 70, back: 1, exited: 20, nextStory: 5 } },
      { igId: "st3", at: new Date("2026-12-03T12:30:00Z"), reach: 50, replies: 0, shares: 0, profileVisits: 0, follows: 0, navigation: {} },
    ];
    expect(await recordStoryStats()).toEqual({ stories: 3, matched: 2 });
    // Read again later: same rows, newer numbers.
    metaRead.stories[0].reach = 260;
    await recordStoryStats();
    expect(await OpsStory.countDocuments()).toBe(3);
    expect((await OpsStory.findOne({ igId: "st1" })).toObject()).toMatchObject({ language: "Tamil", concept: "why351", reach: 260 });

    const r = await api().get("/api/manage/ops/organic").set("x-auth-token", token);
    expect(r.body.stories).toHaveLength(3);
    expect(r.body.storyConcepts.map((c) => c.concept)).toEqual(["why351", "daughters", "not tagged"]);
    expect(r.body.storyConcepts[0]).toMatchObject({ stories: 1, avgReach: 260, profileVisitsPer100: 3.1 });
    metaRead.stories = [];
  });
});

describe("missed runs", () => {
  it("alerts once per gap and marks the alert resolved when runs are back", async () => {
    const { tick } = await import("../src/ops/tick.js");
    await OpsAction.deleteMany({ type: "ops.missed_runs" });
    const ago = (min) => new Date(Date.now() - min * 60000);
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "lastRuns.tick": { at: ago(225), ok: true }, tickLockUntil: null } }, { upsert: true });
    await tick({ source: "test", budgetMs: 1 });
    const alert = await OpsAction.findOne({ type: "ops.missed_runs" });
    expect(alert.title).toMatch(/3 h 45 min ago/);
    expect(alert.payload.resolvedAt ?? null).toBeNull();

    // The next run is on time: the alert is resolved, and no new one is added.
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "lastRuns.tick": { at: ago(15), ok: true }, tickLockUntil: null } });
    await tick({ source: "test", budgetMs: 1 });
    expect((await OpsAction.findById(alert._id)).payload.resolvedAt).toBeTruthy();
    expect(await OpsAction.countDocuments({ type: "ops.missed_runs" })).toBe(1);

    // A second gap the same day gets its own alert.
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "lastRuns.tick": { at: ago(90), ok: true }, tickLockUntil: null } });
    await tick({ source: "test", budgetMs: 1 });
    expect(await OpsAction.countDocuments({ type: "ops.missed_runs" })).toBe(2);
  });
});

describe("fully automatic organic", () => {
  it("plans daily safety posts and stories, and leaves the owner's days alone", async () => {
    const { planWeek, safetyLanguageFor, storyLanguageFor } = await import("../src/ops/organic.js");
    const { OpsStory } = await import("../src/ops/models.js");
    await OpsPost.deleteMany({});
    await OpsStory.deleteMany({});
    metaRead.scheduledTimes = [];
    metaRead.performance = [];
    const ist = new Date(Date.now() + 5.5 * 3600000);
    const add = ((8 - ist.getUTCDay()) % 7) || 7;
    const mondayKey = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add)).toISOString().slice(0, 10);
    // The owner scheduled Monday by hand.
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.organic": "live", "organic.planEvenings": true, "organic.ownerUntil": new Date(`${mondayKey}T12:00:00Z`) } }, { upsert: true });
    organicPlan.mockReturnValue({ posts: [] });
    organicDaily.mockImplementation(() => ({
      items: [1, 2, 3, 4, 5, 6].flatMap((day) => [
        { day, kind: "safety", idea: "daughters", topic: `Safety ${day}`, kicker: "k", headline: "h", subline: "s", cta: "c", caption: "cap", hashtags: ["a"], theme: "cream" },
        { day, kind: "story", idea: "why351", topic: `Story ${day}`, kicker: "k", headline: "h", subline: "", cta: "", caption: "", hashtags: [], theme: "saffron" },
      ]),
    }));
    const r = await planWeek();
    expect(r).toMatchObject({ safety: 6, stories: 6 });
    const posts = await OpsPost.find().lean();
    const days = posts.map((p) => new Date(p.publishAt.getTime() + 5.5 * 3600000).toISOString().slice(0, 10));
    expect(days).not.toContain(mondayKey);
    const story = posts.find((p) => p.kind === "story");
    expect(new Date(story.publishAt.getTime() + 5.5 * 3600000).toISOString().slice(11, 16)).toBe("08:30");
    expect(story.code).toBeUndefined();
    const safety = posts.find((p) => p.kind === "safety");
    expect(new Date(safety.publishAt.getTime() + 5.5 * 3600000).toISOString().slice(11, 16)).toBe("12:30");
    expect(safety.code).toMatch(/s$/);
    expect(safety.design.theme).toBe("maroon");
    expect(await OpsStory.countDocuments()).toBe(6);
    // Languages: safety Mon–Fri fixed, stories cover all five each week.
    const monday = new Date(Date.parse(mondayKey) - 5.5 * 3600000);
    expect([0, 1, 2, 3, 4].map((d) => safetyLanguageFor(monday, d))).toEqual(["Kannada", "Telugu", "Tamil", "Hindi", "English"]);
    expect(new Set([0, 1, 2, 3, 4, 5, 6].map((d) => storyLanguageFor(monday, d))).size).toBe(5);
    organicDaily.mockImplementation(() => ({ items: [] }));
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "organic.ownerUntil": null } });
  });

  it("posts a story on Instagram and Facebook at its time", async () => {
    await OpsPost.deleteMany({});
    const post = await OpsPost.create({ publishAt: new Date(), kind: "story", language: "Tamil", topic: "t", caption: "", design: { headline: "h" }, platforms: ["facebook", "instagram"], imageUrl: "https://ik.example.test/s.jpg", imageFileId: "fs", status: "planned" });
    const a = await OpsAction.create({ module: "organic", type: "organic.story", status: "scheduled", title: "Story", runAt: new Date(), payload: { postId: String(post._id) }, ref: { kind: "post", id: String(post._id) } });
    await execute(a._id);
    expect((await OpsAction.findById(a._id)).status).toBe("done");
    const after = await OpsPost.findById(post._id);
    expect(after.status).toBe("published");
    expect(after.results).toMatchObject({ instagramId: "igstory_1", facebookId: "fbstory_1" });
    expect(imagekit.deleteFile).toHaveBeenCalledWith("fs");
  });

  it("hands stories to the renderer as 9:16", async () => {
    const { renderQueue } = await import("../src/ops/organic.js");
    await OpsPost.deleteMany({});
    await OpsPost.create({ publishAt: new Date(Date.now() + 86400000), kind: "story", language: "Hindi", topic: "t", caption: "", design: { headline: "h", theme: "cream" }, status: "design" });
    const q = await renderQueue();
    expect(q[0]).toMatchObject({ kind: "story", url: "seetharamakalyana.in/hi" });
  });
});

describe("ideas: pricing and the owner's standing ideas", () => {
  it("states the live prices, without the struck-through price or referral discount", async () => {
    const { pricingFacts } = await import("../src/ops/adsIdeas.js");
    const { PRICING_LEVELS } = await import("../src/utils/pricing.js");
    const f = pricingFacts(PRICING_LEVELS[3]);
    expect(f).toMatch(/₹351 with 36 interest credits/);
    expect(f).toMatch(/₹101 for 21/);
    expect(f).not.toMatch(/999|301/);
  });

  it("links pricing posts to the pricing page in their language", async () => {
    const { captionFor } = await import("../src/ops/organic.js");
    const post = { language: "Kannada", code: "kn1208", idea: "pricing", caption: "c", cta: "ನೋಂದಾಯಿಸಿ", hashtags: [] };
    expect(captionFor(post, "facebook")).toMatch(/seetharamakalyana\.in\/kn\/pricing\?p=fkn1208/);
    expect(captionFor(post, "instagram")).toMatch(/seetharamakalyana\.in\/kn\/pricing \(link in bio\)/);
  });

  it("adds an owner idea to the mix, tests it first in ads, and removes it", async () => {
    const { IDEA_KEYS, pickIdeas, ideaTarget } = await import("../src/ops/adsIdeas.js");
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const r = await api().post("/api/manage/ops/ideas/standing").set("x-auth-token", token).send({ text: "Ads for second marriages, ages 35 to 50", target: "ads" });
    expect(r.status).toBe(200);
    const key = r.body.idea.key;
    expect(key).toMatch(/^owner_second_marriages/);
    expect(IDEA_KEYS).toContain(key);
    expect(ideaTarget(key)).toBe("ads");
    expect(pickIdeas({ library: [], language: "Telugu", audience: "parents" }).tests[0]).toMatchObject({ idea: key, why: "your idea (Plan an idea)" });

    const organicOnly = await api().post("/api/manage/ops/ideas/standing").set("x-auth-token", token).send({ text: "Posts about our wedding hall tie-ups", target: "organic" });
    expect(pickIdeas({ library: [], language: "Telugu", audience: "parents" }).tests.map((t) => t.idea)).not.toContain(organicOnly.body.idea.key);

    const list = await api().get("/api/manage/ops/ideas/standing").set("x-auth-token", token);
    expect(list.body.ideas.map((i) => i.key)).toEqual([key, organicOnly.body.idea.key]);
    expect(list.body.builtIn.map((i) => i.key)).toContain("pricing");
    await api().delete(`/api/manage/ops/ideas/standing/${key}`).set("x-auth-token", token);
    await api().delete(`/api/manage/ops/ideas/standing/${organicOnly.body.idea.key}`).set("x-auth-token", token);
    expect(IDEA_KEYS).not.toContain(key);
    expect((await api().post("/api/manage/ops/ideas/standing").set("x-auth-token", token).send({ text: "something long enough", target: "tv" })).status).toBe(400);
  });
});

describe("old two-card pairs", () => {
  it("folds a scheduled delete into its hide card", async () => {
    const { mergeLegacyPairs } = await import("../src/ops/actions.js");
    await OpsAction.deleteMany({});
    const ran = new Date(Date.now() - 3600000);
    const hide = await OpsAction.create({ module: "comments", type: "comments.hide", status: "done", title: "Hide hate comment by X (Facebook)", ranAt: ran, ref: { kind: "comment", id: "c9" }, payload: { platform: "facebook", commentId: "c9", dedupeKey: "comments.hide:c9" } });
    const runAt = new Date(Date.now() + 3600000);
    await OpsAction.create({ module: "comments", type: "comments.delete", status: "scheduled", title: "Delete hidden comment (facebook)", effect: "Deletes it for good.", runAt, ref: { kind: "comment", id: "c9" }, payload: { platform: "facebook", commentId: "c9" } });
    expect(await mergeLegacyPairs()).toBe(1);
    const cards = await OpsAction.find({ "ref.id": "c9" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: "comments.delete", status: "scheduled", title: "Delete hidden hate comment by X (Facebook)" });
    expect(cards[0].runAt.getTime()).toBe(runAt.getTime());
    expect(cards[0].result.steps[0]).toMatchObject({ type: "comments.hide" });
    expect(String(cards[0]._id)).toBe(String(hide._id));
  });
  it("folds finished pairs too, keeping the delete's result", async () => {
    const { mergeLegacyPairs } = await import("../src/ops/actions.js");
    await OpsAction.deleteMany({});
    await OpsAction.create({ module: "comments", type: "comments.hide", status: "done", title: "Hide hate comment by Y (Facebook)", ranAt: new Date(Date.now() - 86400000), ref: { kind: "comment", id: "c8" } });
    await OpsAction.create({ module: "comments", type: "comments.delete", status: "done", title: "Delete hidden comment (facebook)", ranAt: new Date(), result: { deleted: true }, ref: { kind: "comment", id: "c8" } });
    expect(await mergeLegacyPairs()).toBe(1);
    const cards = await OpsAction.find({ "ref.id": "c8" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: "comments.delete", status: "done" });
    expect(cards[0].result).toMatchObject({ deleted: true });
    expect(cards[0].result.steps[0]).toMatchObject({ type: "comments.hide" });
  });
});

describe("stale alerts", () => {
  it("resolves funds and empty-week notes, and moves paid complaints onto the comment card", async () => {
    const { tidyStaleAlerts } = await import("../src/ops/actions.js");
    await OpsAction.deleteMany({});
    await OpsPost.deleteMany({});
    const funds = await OpsAction.create({ module: "ads", type: "ads.funds_low", status: "info", priority: "urgent", title: "Meta funds last ~1.8 days" });
    const week = await OpsAction.create({ module: "organic", type: "organic.week_planned", status: "info", title: "7 posts", payload: { dedupeKey: "week:2026-11-29" } });
    await OpsPost.create({ publishAt: new Date("2026-11-30T14:00:00Z"), language: "Tamil", topic: "t", caption: "c", design: { headline: "h" }, status: "cancelled" });
    const card = await OpsAction.create({ module: "comments", type: "comments.delete", status: "scheduled", title: "Delete hidden hate comment by R (Instagram)", reason: '"paid 351"', ref: { kind: "comment", id: "ig_7" } });
    await OpsAction.create({ module: "comments", type: "comments.paid_complaint", status: "info", title: "R complained about paying", payload: { dedupeKey: "paid:ig_7" } });
    expect(await tidyStaleAlerts()).toBe(3);
    expect((await OpsAction.findById(funds._id)).payload.resolvedAt).toBeTruthy();
    expect((await OpsAction.findById(week._id)).payload.resolvedAt).toBeTruthy();
    const after = await OpsAction.findById(card._id);
    expect(after).toMatchObject({ priority: "urgent", title: "Delete hidden hate comment by R (Instagram): complained about paying" });
    expect(await OpsAction.countDocuments({ type: "comments.paid_complaint" })).toBe(0);
  });
});

describe("Format my mail", () => {
  const admin = async () => tokenFor(await createUser({ rest: { isAdmin: true } }));
  it("turns the owner's notes into a structured reply in the member's language, without saving it", async () => {
    const { ask } = await import("../src/ops/claude.js");
    await OpsMail.create({ uid: 9001, messageId: "<m-format@x>", from: { email: "ravi@example.com", name: "Ravi" }, subject: "OTP not received", text: "I did not get the OTP", language: "Kannada (Kannada script)" });
    const a = await OpsAction.create({ module: "support", type: "support.reply", status: "scheduled", title: "Reply to Ravi", runAt: new Date(Date.now() + 3600000), payload: { to: "ravi@example.com", subject: "OTP not received", inReplyTo: "<m-format@x>", draft: "old draft" } });
    ask.mockResolvedValueOnce("ಆತ್ಮೀಯ ರವಿ,\n\nನಿಮ್ಮ ಖಾತೆ ಪರಿಶೀಲಿಸಲಾಗಿದೆ.\n\nWarm regards,\nTeam Seetha Rama Kalyana");
    const res = await api().post(`/api/manage/ops/actions/${a._id}/format`).set("x-auth-token", await admin()).send({ text: "account verified now, login with email and password" });
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatch(/Team Seetha Rama Kalyana/);
    const call = ask.mock.calls.at(-1)[0];
    expect(call.task).toBe("support.format");
    expect(call.system).toMatch(/Kannada \(Kannada script\)/);
    expect(call.system).toMatch(/Add nothing they don't say/);
    expect(call.system).toMatch(/Every sentence must come from the notes/);
    expect(call.prompt).toMatch(/account verified now/);
    // Nothing is saved until the owner presses Save.
    expect((await OpsAction.findById(a._id)).payload.draft).toBe("old draft");
  });

  it("refuses comment replies, finished cards and empty notes", async () => {
    const reply = await OpsAction.create({ module: "comments", type: "comments.reply", status: "scheduled", title: "Reply", payload: { reply: "hi" } });
    const done = await OpsAction.create({ module: "support", type: "support.reply", status: "done", title: "Reply", payload: { draft: "x" } });
    const open = await OpsAction.create({ module: "support", type: "support.reply", status: "scheduled", title: "Reply", payload: { draft: "x" } });
    const t = await admin();
    expect((await api().post(`/api/manage/ops/actions/${reply._id}/format`).set("x-auth-token", t).send({ text: "thanks a lot" })).status).toBe(400);
    expect((await api().post(`/api/manage/ops/actions/${done._id}/format`).set("x-auth-token", t).send({ text: "thanks a lot" })).status).toBe(409);
    expect((await api().post(`/api/manage/ops/actions/${open._id}/format`).set("x-auth-token", t).send({ text: "ok" })).status).toBe(400);
  });
});

describe("WhatsApp alerts to the owner", () => {
  const OWNER = "9876500001";
  let send;
  const goLive = () => OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.support": "live" } }, { upsert: true });
  const setNumber = () => OpsConfig.updateOne({ _id: "ops" }, { $set: { "alerts.whatsapp": `91${OWNER}` } }, { upsert: true });
  const sentTitles = () => send.mock.calls.map(([, body]) => body.payload.template.to_and_components[0].components.body_1.value);

  beforeEach(async () => {
    const { default: axios } = await import("axios");
    Object.assign(process.env, { MSG91_AUTHKEY: "test-key", MSG91_WHATSAPP_SENDER_ID: "918000000000", MSG91_WHATSAPP_API: "https://msg91.example.test/bulk" });
    send = vi.spyOn(axios, "post").mockResolvedValue({ data: { status: "success", hasError: false } });
    await setNumber();
  });
  afterEach(() => {
    send.mockRestore();
    for (const k of ["MSG91_AUTHKEY", "MSG91_WHATSAPP_SENDER_ID", "MSG91_WHATSAPP_API"]) delete process.env[k];
  });

  it("sends urgent alerts with the ops_alert template, once per 12 hours, and never funds alerts", async () => {
    const { notice } = await import("../src/ops/actions.js");
    await notice("ads", { type: "ads.disapproved", priority: "urgent", title: "2 ads disapproved by Meta", reason: "KN-09: Personal attributes", effect: "Alert only.", payload: { dedupeKey: "d1" } });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, body, opts] = send.mock.calls[0];
    expect(url).toBe("https://msg91.example.test/bulk");
    expect(opts.headers.authkey).toBe("test-key");
    expect(body.payload.template).toMatchObject({ name: "ops_alert", language: { code: "en" } });
    const { to, components } = body.payload.template.to_and_components[0];
    expect(to).toEqual([`91${OWNER}`]);
    expect(components.body_1.value).toBe("2 ads disapproved by Meta");
    expect(components.body_2.value).toMatch(/KN-09: Personal attributes Alert only\./);
    expect((await OpsAction.findOne({ type: "ads.disapproved" })).payload.whatsappAt).toBeTruthy();

    // Not urgent, a low balance, a funds-caused alert, or the same thing again within 12 h: no WhatsApp.
    await notice("ads", { type: "ads.issues", priority: "normal", title: "1 ad has delivery issues", payload: { dedupeKey: "i1" } });
    await notice("tools", { type: "tools.msg91_low", priority: "urgent", title: "MSG91 balance is ₹300", payload: { dedupeKey: "m1" } });
    await notice("ads", { type: "ads.account_status", priority: "urgent", title: "Meta ad account is unsettled", payload: { dedupeKey: "a1", whatsapp: false } });
    await notice("ads", { type: "ads.disapproved", priority: "urgent", title: "2 ads disapproved by Meta", reason: "again", payload: { dedupeKey: "d2", whatsappKey: "d1" } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps Meta payment problems and prepaid-funds stalls off WhatsApp", async () => {
    const { emergencies } = await import("../src/ops/adsEngine.js");
    const unsettled = emergencies({ accountStatus: 3 });
    const disabled = emergencies({ accountStatus: 2 });
    expect(unsettled[0].whatsapp).toBe(false);
    expect(disabled[0].whatsapp).toBeUndefined();
    const stalledNoFunds = emergencies({ today: { funds: 500, spend: 0 }, budgetTotal: 8000, yesterdaySpend: 300 });
    const stalled = emergencies({ today: { funds: 20000, spend: 0 }, budgetTotal: 8000, yesterdaySpend: 300 });
    expect(stalledNoFunds.find((e) => e.type === "ads.delivery_stalled").whatsapp).toBe(false);
    expect(stalled.find((e) => e.type === "ads.delivery_stalled").whatsapp).toBeUndefined();
  });

  it("sends nothing when no number is saved", async () => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "alerts.whatsapp": "" } });
    const { notice } = await import("../src/ops/actions.js");
    await notice("ads", { type: "ads.disapproved", priority: "urgent", title: "x", payload: { dedupeKey: "n1" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("records MSG91's refusal so Settings can show it", async () => {
    send.mockResolvedValueOnce({ data: { status: "fail", hasError: true, errors: "Template not found" } });
    const { notice } = await import("../src/ops/actions.js");
    const a = await notice("ads", { type: "ads.disapproved", priority: "urgent", title: "x", payload: { dedupeKey: "r1" } });
    expect((await OpsAction.findById(a._id)).payload.whatsappError).toMatch(/Template not found/);
    expect((await OpsConfig.findById("ops").lean()).alerts.lastError).toMatch(/Template not found/);
  });

  it("alerts on a member's 3rd mail about a refund, not before", async () => {
    await goLive();
    triage.mockReturnValue({ category: "refund", language: "English", summary: "Wants the ₹351 back", mobile: "", email: "", confidence: 0.9 });
    inbox.push(mail(301, "refund.me@example.test", "refund please"));
    inbox.push(mail(302, "refund.me@example.test", "refund please, still waiting"));
    await runSupportCycle();
    expect(await OpsAction.exists({ type: "support.repeat_mail" })).toBeNull();
    expect(send).not.toHaveBeenCalled();

    inbox.push(mail(303, "refund.me@example.test", "third time asking for my refund"));
    await runSupportCycle();
    const alert = await OpsAction.findOne({ type: "support.repeat_mail" });
    expect(alert).toMatchObject({ priority: "urgent" });
    expect(alert.title).toMatch(/Ramesh has mailed 3 times about a refund/);
    expect(sentTitles()).toEqual([alert.title]);
    expect(send.mock.calls[0][1].payload.template.to_and_components[0].components.body_2.value).toMatch(/From refund\.me@example\.test/);

    // A 4th mail the same day doesn't send a second WhatsApp.
    inbox.push(mail(304, "refund.me@example.test", "hello??"));
    await runSupportCycle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("counts questions the brief can't answer, and starts again after the owner acts", async () => {
    await goLive();
    const { ask } = await import("../src/ops/claude.js");
    const original = ask.getMockImplementation();
    ask.mockImplementation(async (o) => (o.task === "support.reply" ? { reply: "The team will check and reply soon.", answered: false } : original(o)));
    try {
      triage.mockReturnValue({ category: "question", language: "English", summary: "Asks about horoscope matching for Nadi dosha", mobile: "", email: "", confidence: 0.9 });
      inbox.push(mail(311, "curious@example.test", "Do you check nadi dosha?"));
      await runSupportCycle();
      const first = await OpsMail.findOne({ uid: 311 });
      expect(first.needsTeam).toBe(true);
      expect((await OpsAction.findOne({ type: "support.reply", "payload.to": "curious@example.test" })).reason).toMatch(/brief doesn't answer/);

      // The owner answers by hand: earlier mails no longer count.
      await OpsAction.updateMany({ "payload.to": "curious@example.test", type: "support.reply" }, { $set: { status: "done", decidedBy: "SRK0001" } });
      inbox.push(mail(312, "curious@example.test", "and gothra?"));
      inbox.push(mail(313, "curious@example.test", "and gothra??"));
      await runSupportCycle();
      expect(await OpsAction.exists({ type: "support.repeat_mail" })).toBeNull();
      inbox.push(mail(314, "curious@example.test", "hello?"));
      await runSupportCycle();
      expect((await OpsAction.findOne({ type: "support.repeat_mail" })).title).toMatch(/mailed 3 times and needs you/);
    } finally {
      ask.mockImplementation(original);
    }
  });

  it("doesn't count questions the agent answered", async () => {
    await goLive();
    triage.mockReturnValue({ category: "question", language: "English", summary: "Asks the price", mobile: "", email: "", confidence: 0.9 });
    for (const uid of [321, 322, 323]) inbox.push(mail(uid, "price@example.test", "price?"));
    await runSupportCycle();
    expect(await OpsAction.exists({ type: "support.repeat_mail" })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends an urgent mail (safety, legal, payment dispute) at once", async () => {
    await goLive();
    triage.mockReturnValue({ category: "urgent", language: "English", summary: "Says a profile is cheating them", mobile: "", email: "", confidence: 0.9 });
    inbox.push(mail(331, "worried@example.test", "this profile asked me for money"));
    await runSupportCycle();
    expect(sentTitles()).toEqual(["Urgent: Ramesh"]);
  });

  it("alerts when a job keeps failing and marks it resolved when it works again", async () => {
    const { tick } = await import("../src/ops/tick.js");
    const { fetchNewMail } = await import("../src/ops/mail.js");
    await goLive();
    fetchNewMail.mockRejectedValueOnce(new Error("IMAP login failed")).mockRejectedValueOnce(new Error("IMAP login failed")).mockRejectedValueOnce(new Error("IMAP login failed"));
    await tick({ only: "support" });
    await tick({ only: "support" });
    expect(await OpsAction.exists({ type: "ops.job_failing" })).toBeNull();
    await tick({ only: "support" });
    const alert = await OpsAction.findOne({ type: "ops.job_failing" });
    expect(alert.title).toBe("Reading the support inbox is failing");
    expect(alert.reason).toMatch(/3 times in a row.*IMAP login failed/);
    expect(sentTitles()).toEqual(["Reading the support inbox is failing"]);
    expect((await OpsConfig.findById("ops").lean()).lastRuns.support.fails).toBe(3);

    await tick({ only: "support" });
    expect((await OpsAction.findById(alert._id)).payload.resolvedAt).toBeTruthy();
    expect((await OpsConfig.findById("ops").lean()).lastRuns.support.fails).toBeUndefined();
  });

  it("alerts when registration OTPs fail 3 times in a row, never for an MSG91 balance error", async () => {
    const { flowFailed, flowOk } = await import("../src/ops/health.js");
    await flowFailed("otp", new Error("Template paused"));
    await flowOk("otp");
    await flowFailed("otp", new Error("Template paused"));
    await flowFailed("otp", new Error("Template paused"));
    expect(await OpsAction.exists({ type: "ops.flow_failing" })).toBeNull();
    await flowFailed("otp", { message: "x", response: { data: { message: "Template paused by Meta" } } });
    const alert = await OpsAction.findOne({ type: "ops.flow_failing" });
    expect(alert.title).toBe("Registration OTPs are failing");
    expect(alert.reason).toMatch(/Template paused by Meta/);
    expect(sentTitles()).toEqual(["Registration OTPs are failing"]);
    await flowOk("otp");
    expect((await OpsAction.findById(alert._id)).payload.resolvedAt).toBeTruthy();

    await OpsAction.deleteMany({ type: "ops.flow_failing" });
    for (let i = 0; i < 3; i++) await flowFailed("otp", new Error("Insufficient balance"));
    expect((await OpsAction.findOne({ type: "ops.flow_failing" })).payload.whatsapp).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("saves the number from Settings and sends a test", async () => {
    const t = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const bad = await api().post("/api/manage/ops/config").set("x-auth-token", t).send({ alerts: { whatsapp: "12345" } });
    expect(bad.status).toBe(400);
    const ok = await api().post("/api/manage/ops/config").set("x-auth-token", t).send({ alerts: { whatsapp: "+91 98765 00002" } });
    expect(ok.status).toBe(200);
    expect(ok.body.alerts).toMatchObject({ whatsapp: "919876500002", ready: true, template: "ops_alert" });
    const test = await api().post("/api/manage/ops/alerts/test").set("x-auth-token", t);
    expect(test.status).toBe(200);
    expect(send.mock.calls[0][1].payload.template.to_and_components[0].to).toEqual(["919876500002"]);
    const overview = await api().get("/api/manage/ops/overview").set("x-auth-token", t);
    expect(overview.body.alerts.lastSentAt).toBeTruthy();
    // Clearing the number turns WhatsApp alerts off.
    const off = await api().post("/api/manage/ops/config").set("x-auth-token", t).send({ alerts: { whatsapp: "" } });
    expect(off.body.alerts.whatsapp).toBe("");
  });
});

describe("new-ad launches that Meta refuses", () => {
  const admin = async () => tokenFor(await createUser({ rest: { isAdmin: true } }));
  const metaError = (message, extra = {}) => Object.assign(new Error(message), { meta: { message, code: 100, ...extra } });
  const withImages = async (fn) => {
    const before = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(Buffer.from("jpeg-bytes")));
    try {
      return await fn();
    } finally {
      globalThis.fetch = before;
    }
  };
  const launchCard = async (runAt = new Date()) => {
    await OpsConfig.updateOne({ _id: "ops" }, { $set: { "modes.ads": "live" } }, { upsert: true });
    const c = await OpsCreative.create({ campaignId: "c1", adsetId: "s1", language: "Tamil", baseAdId: "ad_best", status: "ready", imageUrl: "https://ik.example.test/ta.jpg", design: { headline: "உங்கள் சமூகம்" }, primaryText: "உரை", title: "தலைப்பு" });
    const a = await OpsAction.create({
      module: "ads", type: "ads.creative_launch", status: "scheduled", title: "1 new ad for SRK | Tamil", runAt,
      payload: { campaignId: "c1", adsetId: "s1", creativeIds: [String(c._id)], baseAdId: "ad_best", replaceAdId: null },
    });
    return { c, a };
  };

  it("copies only what Meta accepts on a new creative (Graph v22)", async () => {
    const { creativeFieldsFor } = await import("../src/ops/adsCreative.js");
    const spec = {
      url_tags: "utm_source=meta",
      object_story_spec: {
        page_id: "pg1",
        instagram_actor_id: "ig1",
        link_data: { link: "https://x.test/ta", picture: "old.jpg", image_crops: { "100x100": [[0, 0], [10, 10]] }, image_hash: "old", message: "old", name: "old", call_to_action: { type: "SIGN_UP", value: { link: "https://x.test/ta" } } },
      },
      degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } },
    };
    const f = creativeFieldsFor(spec, { name: "Ops | Tamil", link: "https://x.test/ta/pricing?utm_content=a", urlTags: "utm_source=meta&utm_content=a", hash: "new", message: "உரை", title: "தலைப்பு" });
    expect(f.object_story_spec).toMatchObject({ page_id: "pg1", instagram_user_id: "ig1" });
    expect(f.object_story_spec.instagram_actor_id).toBeUndefined();
    expect(f.object_story_spec.link_data).toEqual({
      link: "https://x.test/ta/pricing?utm_content=a",
      image_hash: "new",
      message: "உரை",
      name: "தலைப்பு",
      call_to_action: { type: "SIGN_UP", value: { link: "https://x.test/ta/pricing?utm_content=a" } },
    });
    expect(f.degrees_of_freedom_spec).toBeUndefined();
    // Individual Advantage+ features are kept as the copied ad had them.
    const kept = creativeFieldsFor({ ...spec, degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: {}, image_touchups: { enroll_status: "OPT_OUT" } } } }, { name: "n", link: "l", hash: "h" });
    expect(kept.degrees_of_freedom_spec).toEqual({ creative_features_spec: { image_touchups: { enroll_status: "OPT_OUT" } } });
  });

  it("keeps Meta's own explanation, not just 'Invalid parameter'", async () => {
    const { metaMessage, metaErrorText } = await import("../src/ops/meta.js");
    const e = { message: "Invalid parameter", code: 100, error_subcode: 3858504, error_user_title: "Deprecated field", error_user_msg: "standard_enhancements is no longer supported." };
    expect(metaMessage(e)).toBe("Invalid parameter (Deprecated field: standard_enhancements is no longer supported.) [subcode 3858504]");
    expect(metaErrorText({ meta: e })).toMatch(/standard_enhancements is no longer supported/);
  });

  it("names the failed step, removes the half-made copy, and a retry reuses the creative", async () => {
    const meta = await import("../src/ops/meta.js");
    const { c, a } = await launchCard();
    meta.createCreative.mockClear();
    meta.graphPost.mockRejectedValueOnce(metaError("Invalid parameter", { error_user_msg: "The creative can't be used with this ad." }));
    await withImages(() => execute(a._id));
    const failed = await OpsAction.findById(a._id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^Putting the new creative on the copy: Invalid parameter \(The creative can't be used with this ad\.\)/);
    expect(metaCalls.graphDelete).toHaveBeenCalledWith("ad_new");
    expect((await OpsCreative.findById(c._id)).metaCreativeId).toBe("cr_1");
    const alert = await OpsAction.findOne({ type: "ads.action_failed" });
    expect(alert.reason).toMatch(/can't be used with this ad/);

    const t = await admin();
    const res = await withImages(async () => await api().post(`/api/manage/ops/actions/${a._id}/retry`).set("x-auth-token", t));
    expect(res.status).toBe(200);
    const done = await OpsAction.findById(a._id);
    expect(done.status).toBe("done");
    expect(done.result.adIds).toEqual(["ad_new"]);
    // The creative made on the first try is reused, not made again.
    expect(meta.createCreative).toHaveBeenCalledTimes(1);
    expect((await OpsCreative.findById(c._id)).status).toBe("live");
    expect((await OpsAction.findById(alert._id)).payload.resolvedAt).toBeTruthy();
  });

  it("only failed actions can be retried", async () => {
    const { a } = await launchCard(new Date(Date.now() + 3600000));
    const res = await api().post(`/api/manage/ops/actions/${a._id}/retry`).set("x-auth-token", await admin());
    expect(res.status).toBe(409);
  });

  it("checks launches due within a day ahead, alerts once if Meta refuses, and touches no ad", async () => {
    const meta = await import("../src/ops/meta.js");
    const { preflightLaunches } = await import("../src/ops/adsCreative.js");
    const { c, a } = await launchCard(new Date(Date.now() + 15 * 3600000));
    meta.copyAd.mockClear();
    meta.createCreative.mockRejectedValueOnce(metaError("Invalid parameter", { error_user_msg: "Instagram account field is not valid." }));
    await withImages(() => preflightLaunches());
    const alert = await OpsAction.findOne({ type: "ads.launch_check_failed" });
    expect(alert).toMatchObject({ priority: "urgent" });
    expect(alert.reason).toMatch(/creating the creative: Invalid parameter \(Instagram account field is not valid\.\)/);
    expect((await OpsAction.findById(a._id)).payload.checkError).toMatch(/Instagram account/);
    expect(meta.copyAd).not.toHaveBeenCalled();

    // Not checked again within 3 hours; after that it passes and the alert is resolved.
    await withImages(() => preflightLaunches());
    expect(meta.createCreative).toHaveBeenCalledTimes(1);
    await withImages(() => preflightLaunches({ now: Date.now() + 3.1 * 3600000 }));
    expect((await OpsCreative.findById(c._id)).metaCreativeId).toBe("cr_1");
    expect((await OpsAction.findById(a._id)).payload.checkError).toBeNull();
    expect((await OpsAction.findById(alert._id)).payload.resolvedAt).toBeTruthy();
    expect(meta.copyAd).not.toHaveBeenCalled();
  });

  it("lets an admin check a launch card by hand", async () => {
    const { a } = await launchCard(new Date(Date.now() + 40 * 3600000));
    const t = await admin();
    const res = await withImages(async () => await api().post(`/api/manage/ops/actions/${a._id}/check`).set("x-auth-token", t));
    expect(res.status).toBe(200);
    expect(res.body.msg).toMatch(/Ready: 1 creative/);
  });
});
