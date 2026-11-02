import { beforeEach, describe, expect, it, vi } from "vitest";
import sendEmail from "../src/config/msg91Email.js";
import upStash from "../src/config/upStash.js";
import AbandonedCheckout from "../src/models/AbandonedCheckout.js";
import { DEFAULT_PRICING_LEVEL, PRICING_LEVELS } from "../src/utils/pricing.js";
import {
  api,
  createBroker,
  createUser,
  paidOrder,
  registrationForm,
  tokenFor,
  webhookSignature,
} from "./helpers.js";

const { registrationFee: REGISTRATION_FEE } = PRICING_LEVELS[DEFAULT_PRICING_LEVEL];
const TEMPLATE = "complete_registration_test";
const HOUR = 3600000;

beforeEach(async () => {
  process.env.MSG91_TEMPLATE_COMPLETE_REGISTRATION = TEMPLATE;
  // registrationForm()'s photo, as if uploaded through /user-register/upload-images.
  await upStash.set("upload:asha", "1");
});

let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

const startCheckout = async (overrides = {}) => {
  const res = await api()
    .post("/api/create-order")
    .set("X-Forwarded-For", freshIp())
    .send({ purpose: "registration", registration: registrationForm(overrides) });
  expect(res.status).toBe(200);
  return res.body.orderId;
};

const webhook = (payload) => {
  const raw = JSON.stringify(payload);
  return api()
    .post("/api/razorpay-webhook")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", webhookSignature(raw))
    .send(raw);
};

const failed = (orderId, description = "Payment Timed Out") => ({
  event: "payment.failed",
  payload: {
    payment: { entity: { id: "pay_f", order_id: orderId, error_reason: "payment_timed_out", error_description: description } },
  },
});

const adminToken = async () => tokenFor(await createUser({ rest: { isAdmin: true } }));

const list = async (token, query = {}) =>
  api().get("/api/manage/abandoned").query(query).set("x-auth-token", token);

const email = (token, ids) =>
  api().post("/api/manage/abandoned/email").set("x-auth-token", token).send({ ids });

const row = () => AbandonedCheckout.findOne({ email: "asha@example.test" }).lean();

/** An abandoned row saved straight to the database. */
const seedRow = (overrides = {}) =>
  AbandonedCheckout.create({
    email: "ravi@example.test",
    name: "Ravi Kumar",
    mobile: "9000000001",
    amount: REGISTRATION_FEE,
    orderId: "order_seed",
    orderIds: ["order_seed"],
    attempts: 1,
    lastAttemptAt: new Date(),
    ...overrides,
  });

describe("capturing abandoned registrations", () => {
  it("saves who reached Razorpay when /create-order runs", async () => {
    const orderId = await startCheckout();
    expect(await row()).toMatchObject({
      name: "Asha Rao",
      mobile: "9876500001",
      profileCreatedBy: "Self",
      amount: REGISTRATION_FEE,
      orderId,
      attempts: 1,
      status: "not_attempted",
      emailCount: 0,
    });
  });

  it("keeps one row per email and counts retries", async () => {
    const first = await startCheckout();
    await webhook(failed(first));
    const second = await startCheckout({ fullName: "Asha R" });

    const rows = await AbandonedCheckout.find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Asha R", orderId: second, attempts: 2, status: "not_attempted" });
    expect(rows[0].failureReason).toBeUndefined();
    expect(rows[0].orderIds).toEqual([first, second]);
  });

  it("leaves out ₹1 test orders", async () => {
    await upStash.set("upload:asha", "1");
    await startCheckout({ email: "rupee@example.test" });
    expect(await AbandonedCheckout.countDocuments()).toBe(0);
  });

  it("ignores other kinds of payment", async () => {
    const member = await createUser();
    await api()
      .post("/api/create-order")
      .set("X-Forwarded-For", freshIp())
      .set("x-auth-token", tokenFor(member))
      .send({ purpose: "interest", pack: "1" });
    expect(await AbandonedCheckout.countDocuments()).toBe(0);
  });
});

describe("Razorpay webhook updates", () => {
  it("records a failed payment with Razorpay's reason", async () => {
    const orderId = await startCheckout();
    const res = await webhook(failed(orderId));
    expect(res.body.status).toBe("recorded");
    expect(await row()).toMatchObject({ status: "failed", failureReason: "Payment Timed Out" });
  });

  it("marks order.paid as paid, and a later failure doesn't undo it", async () => {
    const orderId = await startCheckout();
    await webhook({ event: "order.paid", payload: { order: { entity: { id: orderId } } } });
    await webhook(failed(orderId));
    expect((await row()).status).toBe("paid");
  });

  it("doesn't let a failure on an older order overwrite the latest attempt", async () => {
    const first = await startCheckout();
    await startCheckout();
    await webhook(failed(first));
    expect((await row()).status).toBe("not_attempted");
  });

  it("rejects a wrongly signed failure event", async () => {
    const orderId = await startCheckout();
    const res = await api()
      .post("/api/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", "bad")
      .send(JSON.stringify(failed(orderId)));
    expect(res.status).toBe(400);
    expect((await row()).status).toBe("not_attempted");
  });
});

describe("conversion tracking", () => {
  it("marks the row paid and joined when the registration completes", async () => {
    const orderId = await startCheckout();
    const res = await api().post("/api/user-register").send(paidOrder(orderId));
    expect(res.status).toBe(200);
    const r = await row();
    expect(r.status).toBe("paid");
    expect(r.convertedAt).toBeInstanceOf(Date);
    expect(r.convertedAfterEmail).toBe(false);
  });

  it("notices members who joined some other way, and whether it was after an email", async () => {
    const token = await adminToken();
    const emailedAt = new Date(Date.now() - 2 * HOUR);
    await seedRow({ emailCount: 1, lastEmailedAt: emailedAt, emails: [{ at: emailedAt, ok: true }] });
    await createUser({ basic: { mobile: "9000000001" } });

    const res = await list(token);
    expect(res.body.rows[0]).toMatchObject({ convertedAfterEmail: true });
    expect(res.body.rows[0].convertedAt).toBeTruthy();
    expect(res.body.summary).toMatchObject({ total: 1, emailed: 1, converted: 1, convertedAfterEmail: 1, emailConversionRate: 1 });
  });
});

describe("GET /manage/abandoned", () => {
  it("is admin only", async () => {
    const member = tokenFor(await createUser());
    const broker = tokenFor(await createBroker(), "BROKER");
    expect((await list(member)).status).toBe(404);
    expect((await list(broker)).status).toBe(404);
    expect((await api().get("/api/manage/abandoned")).status).toBe(401);
    expect((await email(member, [])).status).toBe(404);
  });

  it("filters by status, emailed, converted, date and search, newest first", async () => {
    const token = await adminToken();
    const day = (d) => new Date(`2026-10-${d}T12:00:00+05:30`);
    await seedRow({ email: "a@example.test", name: "Anil", mobile: "9000000011", lastAttemptAt: day(10) });
    await seedRow({ email: "b@example.test", name: "Bhavya", mobile: "9000000012", lastAttemptAt: day(20), status: "failed", emailCount: 1 });
    await seedRow({ email: "c@example.test", name: "Chetan", mobile: "9000000013", lastAttemptAt: day(25), convertedAt: day(26) });

    const names = async (q) => (await list(token, q)).body.rows.map((r) => r.name);
    expect(await names({})).toEqual(["Chetan", "Bhavya", "Anil"]);
    expect(await names({ status: "failed" })).toEqual(["Bhavya"]);
    expect(await names({ emailed: "never" })).toEqual(["Chetan", "Anil"]);
    expect(await names({ emailed: "yes" })).toEqual(["Bhavya"]);
    expect(await names({ converted: "no" })).toEqual(["Bhavya", "Anil"]);
    expect(await names({ converted: "yes" })).toEqual(["Chetan"]);
    expect(await names({ from: "2026-10-15", to: "2026-10-20" })).toEqual(["Bhavya"]);
    expect(await names({ q: "9000000011" })).toEqual(["Anil"]);
    expect(await names({ q: "B@EXAMPLE" })).toEqual(["Bhavya"]);
    expect(await names({ q: "(.*" })).toEqual([]);
  });
});

describe("POST /manage/abandoned/email", () => {
  it("sends the template and logs who sent it", async () => {
    const admin = await createUser({ rest: { isAdmin: true }, basic: { fullName: "Site Admin" } });
    const r = await seedRow();
    vi.mocked(sendEmail).mockResolvedValueOnce({ status: "success", data: { unique_id: "m1" } });

    const res = await email(tokenFor(admin), [String(r._id)]);
    expect(res.body).toMatchObject({ sent: 1, results: [{ ok: true }] });
    expect(sendEmail).toHaveBeenCalledWith({
      to: [{ email: "ravi@example.test", name: "Ravi Kumar" }],
      template_id: TEMPLATE,
      variables: { name: "Ravi Kumar" },
    });
    const saved = await AbandonedCheckout.findById(r._id).lean();
    expect(saved.emailCount).toBe(1);
    expect(saved.emails[0]).toMatchObject({ ok: true, byName: "Site Admin", response: { status: "success" } });

    const listed = (await list(tokenFor(admin))).body.rows[0];
    expect(listed).toMatchObject({ emailCount: 1, lastEmailedBy: "Site Admin" });
  });

  it("blocks a second email within 24 hours", async () => {
    const token = await adminToken();
    const r = await seedRow();
    await email(token, [String(r._id)]);
    const again = await email(token, [String(r._id)]);
    expect(again.body.results[0]).toMatchObject({ ok: false, msg: "Emailed in the last 24 hours" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("allows another after 24 hours, up to 3 per person", async () => {
    const token = await adminToken();
    const old = new Date(Date.now() - 25 * HOUR);
    const r = await seedRow({ emailCount: 2, lastEmailedAt: old });
    expect((await email(token, [String(r._id)])).body.sent).toBe(1);

    await AbandonedCheckout.updateOne({ _id: r._id }, { lastEmailedAt: old });
    const fourth = await email(token, [String(r._id)]);
    expect(fourth.body.results[0]).toMatchObject({ ok: false, msg: "Already emailed 3 times" });
  });

  it("never emails someone who has joined, even if the list is stale", async () => {
    const token = await adminToken();
    const joined = await seedRow({ convertedAt: new Date() });
    const stale = await seedRow({ email: "new@example.test", mobile: "9000000002" });
    await createUser({ basic: { email: "new@example.test" } });

    const res = await email(token, [String(joined._id), String(stale._id)]);
    expect(res.body.results.map((x) => x.msg)).toEqual(["Already joined", "Already joined"]);
    expect(sendEmail).not.toHaveBeenCalled();
    const s = await AbandonedCheckout.findById(stale._id).lean();
    expect(s.emailCount).toBe(0);
    expect(s.convertedAt).toBeTruthy();
  });

  it("doesn't use up the quota when MSG91 fails, but logs the error", async () => {
    const token = await adminToken();
    const r = await seedRow();
    vi.mocked(sendEmail).mockRejectedValueOnce(Object.assign(new Error("boom"), { response: { data: { message: "Invalid template" } } }));

    const res = await email(token, [String(r._id)]);
    expect(res.body.results[0]).toMatchObject({ ok: false, msg: "Email provider error" });
    const saved = await AbandonedCheckout.findById(r._id).lean();
    expect(saved.emailCount).toBe(0);
    expect(saved.lastEmailedAt).toBeNull();
    expect(saved.emails[0]).toMatchObject({ ok: false, response: { message: "Invalid template" } });
  });

  it("sends to several people at once and validates the ids", async () => {
    const token = await adminToken();
    const a = await seedRow();
    const b = await seedRow({ email: "b@example.test", mobile: "9000000003" });
    expect((await email(token, [String(a._id), String(b._id)])).body.sent).toBe(2);
    expect((await email(token, [])).status).toBe(400);
    expect((await email(token, ["not-an-id"])).status).toBe(400);
  });

  it("refuses to send when the template id isn't configured", async () => {
    delete process.env.MSG91_TEMPLATE_COMPLETE_REGISTRATION;
    const token = await adminToken();
    const r = await seedRow();
    const res = await email(token, [String(r._id)]);
    expect(res.status).toBe(500);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
