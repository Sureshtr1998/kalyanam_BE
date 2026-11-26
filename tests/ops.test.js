import { beforeEach, describe, expect, it, vi } from "vitest";

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
const commentTriage = vi.fn();
const metaCalls = vi.hoisted(() => ({ setStatus: vi.fn(async () => ({})), setDailyBudget: vi.fn(async () => ({})) }));
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
  fetchCreativeSpec: vi.fn(async () => ({
    object_story_spec: { page_id: "pg1", link_data: { link: "https://www.seetharamakalyana.in/kn", message: "old", name: "old", picture: "x", call_to_action: { type: "SIGN_UP" } } },
    url_tags: "utm_source=meta",
  })),
  uploadAdImage: vi.fn(async () => "hash_1"),
  fetchAds: vi.fn(async () => [{ id: "ad_kn1", name: "KN-09 Why351", adset_id: "s_kn", campaign_id: "c_kn", effective_status: "ACTIVE" }]),
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
  ask: vi.fn(async ({ task }) => (task === "support.triage" ? triage() : task === "comments.triage" ? commentTriage() : task === "ideas.plan" ? ideaPlan() : "ನಮಸ್ಕಾರ, ನಿಮ್ಮ ಖಾತೆ ಪರಿಶೀಲಿಸಲಾಗಿದೆ. — Team Seetha Rama Kalyana")),
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
    qstashCalls.push({ url: String(url), headers: init?.headers });
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
    const del = await OpsAction.findOne({ type: "comments.delete" });
    expect(del.status).toBe("scheduled");
    expect((del.runAt.getTime() - Date.now()) / 3600000).toBeGreaterThan(23.9);
    expect(await OpsAction.exists({ type: "comments.paid_complaint" })).toBeTruthy();
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

  it("puts ad creatives in the render queue next to posts", async () => {
    await OpsPost.deleteMany({});
    await OpsCreative.deleteMany({});
    await OpsCreative.create({ language: "Telugu", design: { headline: "కొత్త ప్రారంభం", theme: "cream" } });
    const q = await api().get("/api/ops/render-queue").set({ "x-internal-secret": process.env.INTERNAL_ROUTE_SECRET });
    expect(q.body.posts).toEqual([expect.objectContaining({ kind: "ad", language: "Telugu", headline: "కొత్త ప్రారంభం" })]);
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

describe("automation starts itself", () => {
  it("creates the 15-minute schedule when the Ops tab is first opened, once a day at most", async () => {
    qstashCalls.length = 0;
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const first = await api().get("/api/manage/ops/overview").set("x-auth-token", token);
    expect(first.body.automation).toMatchObject({ ready: true, scheduled: true });
    expect(qstashCalls).toHaveLength(1);
    expect(qstashCalls[0].url).toMatch(/schedules\/.*ops\/tick$/);
    expect(qstashCalls[0].headers["Upstash-Cron"]).toBe("*/15 * * * *");
    expect(qstashCalls[0].headers["Upstash-Schedule-Id"]).toBe("ops-tick");

    await api().get("/api/manage/ops/overview").set("x-auth-token", token);
    expect(qstashCalls).toHaveLength(1);

    const restart = await api().post("/api/manage/ops/automation/start").set("x-auth-token", token);
    expect(restart.status).toBe(200);
    expect(qstashCalls).toHaveLength(2);
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
