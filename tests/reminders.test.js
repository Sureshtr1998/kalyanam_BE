import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The support mailbox is replaced; MSG91 email is mocked in setup.js; WhatsApp goes through a spied axios.
const sent = [];
vi.mock("../src/ops/mail.js", () => ({
  mailConfigured: () => true,
  fetchNewMail: vi.fn(async () => []),
  sendMail: vi.fn(async (m) => {
    sent.push(m);
    return { messageId: "<sent@test>" };
  }),
  testMailLogin: vi.fn(async () => ({ messages: 1 })),
}));

const { default: dbConnect } = await import("../src/utils/dbConnect.js");
const { createUser, api } = await import("./helpers.js");
const { default: User } = await import("../src/models/User.js");
const { default: AbandonedCheckout } = await import("../src/models/AbandonedCheckout.js");
const { default: sendEmail } = await import("../src/config/msg91Email.js");
const { default: axios } = await import("axios");
const { runReminders, OpsReminder, stopLink, quietHours, REMINDER_GAP_MS } = await import("../src/ops/reminders.js");

const HOUR = 3600000;
const DAY = 24 * HOUR;
// 27 Nov 2026, 11:30 am IST.
const NOON = Date.UTC(2026, 10, 27, 6, 0);
let whatsapp;

const checkout = (over = {}) =>
  AbandonedCheckout.create({ email: `left${Math.random().toString(36).slice(2, 8)}@example.test`, name: "Asha", mobile: "9876500011", amount: 351, attempts: 1, lastAttemptAt: new Date(NOON - 3 * HOUR), ...over });

const unverified = async (createdAt, over = {}) => {
  const u = await createUser({ rest: { isVerified: false, ...over } });
  await User.collection.updateOne({ _id: u._id }, { $set: { createdAt: new Date(createdAt) } });
  return u;
};

beforeAll(async () => {
  await dbConnect();
});
beforeEach(async () => {
  sent.length = 0;
  vi.mocked(sendEmail).mockClear();
  Object.assign(process.env, { MSG91_AUTHKEY: "k", MSG91_WHATSAPP_SENDER_ID: "918000000000", MSG91_WHATSAPP_API: "https://msg91.example.test/bulk" });
  whatsapp = vi.spyOn(axios, "post").mockResolvedValue({ data: { status: "success" } });
  await Promise.all([AbandonedCheckout.deleteMany({}), OpsReminder.deleteMany({}), User.deleteMany({})]);
});
afterEach(() => {
  whatsapp.mockRestore();
  for (const k of ["MSG91_AUTHKEY", "MSG91_WHATSAPP_SENDER_ID", "MSG91_WHATSAPP_API"]) delete process.env[k];
});

describe("reminders to unpaid sign-ups", () => {
  it("reminds 2 hours after they left, then every 3 days, 3 times at most, by email and WhatsApp", async () => {
    const row = await checkout();
    const r1 = await runReminders({ now: NOON });
    expect(r1).toMatchObject({ unpaid: 1 });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ template_id: "complete_registration_en", to: [{ email: row.email, name: "Asha" }] }));
    const wa = whatsapp.mock.calls[0][1].payload.template;
    expect(wa).toMatchObject({ name: "registration_link_noref", language: { code: "en" } });
    expect(wa.to_and_components[0].to).toEqual(["919876500011"]);
    expect((await AbandonedCheckout.findById(row._id)).emailCount).toBe(1);

    // Not again within 3 days.
    await runReminders({ now: NOON + DAY });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await runReminders({ now: NOON + REMINDER_GAP_MS });
    await runReminders({ now: NOON + 2 * REMINDER_GAP_MS });
    await runReminders({ now: NOON + 3 * REMINDER_GAP_MS });
    expect(sendEmail).toHaveBeenCalledTimes(3);
    const after = await AbandonedCheckout.findById(row._id);
    expect(after.emailCount).toBe(3);
    expect(after.emails.every((e) => e.ok && /Ops agent/.test(e.byName))).toBe(true);
  });

  it("waits 2 hours, and skips people who joined, paid, opted out or already had 3 emails", async () => {
    await checkout({ lastAttemptAt: new Date(NOON - HOUR) });
    await checkout({ status: "paid" });
    await checkout({ remindersOff: true });
    await checkout({ emailCount: 3, lastEmailedAt: new Date(NOON - 10 * DAY) });
    const member = await createUser();
    await checkout({ email: member.basic.email });
    const r = await runReminders({ now: NOON });
    expect(r.unpaid).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("counts the Abandoned tab's manual emails and waits 3 days after the last one", async () => {
    const row = await checkout({ emailCount: 1, lastEmailedAt: new Date(NOON - DAY) });
    await runReminders({ now: NOON });
    expect(sendEmail).not.toHaveBeenCalled();
    await runReminders({ now: NOON + 2 * DAY + HOUR });
    expect((await AbandonedCheckout.findById(row._id)).emailCount).toBe(2);
  });
});

describe("reminders to members who haven't verified", () => {
  it("emails from the support mailbox 1, 4 and 7 days after joining, with the reply-with-mobile way out", async () => {
    const u = await unverified(NOON - 2 * DAY);
    await unverified(NOON - HOUR); // joined an hour ago: not yet
    await createUser({ rest: { isVerified: true } });
    await runReminders({ now: NOON });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(u.basic.email);
    expect(sent[0].text).toMatch(/reply to this email with your registered mobile number/);
    expect(sent[0].text).toMatch(/reminders\/stop\?k~?=?verify/.source ? /reminders\/stop\?k=verify/ : /x/);
    // A day later only the newer member gets their first; u waits 3 days.
    await runReminders({ now: NOON + DAY });
    expect(sent.filter((m) => m.to === u.basic.email)).toHaveLength(1);
    expect(sent).toHaveLength(2);
    await runReminders({ now: NOON + REMINDER_GAP_MS });
    await runReminders({ now: NOON + 2 * REMINDER_GAP_MS });
    await runReminders({ now: NOON + 5 * REMINDER_GAP_MS });
    expect(sent.filter((m) => m.to === u.basic.email)).toHaveLength(3);
  });

  it("stops after they verify, or when they use the stop link", async () => {
    const u = await unverified(NOON - 2 * DAY);
    const link = new URL(stopLink("verify", String(u._id)));
    const bad = await api().get(`/api/reminders/stop?k=verify&id=${u._id}&s=forged`);
    expect(bad.status).toBe(400);
    const ok = await api().get(`/api/reminders/stop${link.search}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toMatch(/won't get more reminders/);
    await runReminders({ now: NOON });
    expect(sent).toHaveLength(0);
  });
});

describe("pacing and failures", () => {
  it("sends nothing at night, and at most 8 per run", async () => {
    for (let i = 0; i < 12; i++) await checkout({ mobile: undefined });
    expect(quietHours(Date.UTC(2026, 10, 27, 16, 0))).toBe(true); // 9:30 pm IST
    expect(await runReminders({ now: Date.UTC(2026, 10, 27, 16, 0) })).toMatchObject({ skipped: expect.stringMatching(/quiet hours/) });
    const r = await runReminders({ now: NOON });
    expect(r.unpaid).toBe(8);
  });

  it("fails the job when nothing could be sent, so the owner is alerted", async () => {
    await checkout({ mobile: undefined });
    await checkout({ mobile: undefined });
    vi.mocked(sendEmail).mockRejectedValue(new Error("MSG91 email down"));
    await expect(runReminders({ now: NOON })).rejects.toThrow(/No reminder could be sent: email: MSG91 email down/);
    // A failed send doesn't use up one of their 3.
    expect((await AbandonedCheckout.find()).map((r) => r.emailCount)).toEqual([0, 0]);
    vi.mocked(sendEmail).mockResolvedValue({});
  });
});

describe("addresses a mail server would reject", () => {
  it("skips them for good instead of failing every run", async () => {
    const u = await unverified(NOON - 2 * DAY);
    await User.updateOne({ _id: u._id }, { $set: { "basic.email": "bad address@example.test" } });
    await runReminders({ now: NOON });
    expect(sent).toHaveLength(0);
    expect((await User.findById(u._id)).reminders.bounced).toBe(true);
  });
});
