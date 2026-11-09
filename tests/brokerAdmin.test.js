import { describe, expect, it, vi } from "vitest";
import razorpay from "../src/config/razorpay.js";
import { notify } from "../src/config/msg91Email.js";
import Broker from "../src/models/Broker.js";
import { PASSWORD, api, createBroker, createUser, tokenFor } from "./helpers.js";

const asAdmin = async () => tokenFor(await createUser({ rest: { isAdmin: true } }));
const pendingBroker = () =>
  createBroker({
    status: "pending",
    referralId: undefined,
    transactions: [{ orderId: "order_p", paymentId: "pay_p", amountPaid: 501, note: "Partner registration" }],
  });
const post = (token, path, body) => api().post(`/api${path}`).set("x-auth-token", token).send(body);
const emailsTo = (template) =>
  vi.mocked(notify).mock.calls.filter(([o]) => o.template_id === template).map(([o]) => o);

describe("admin: partner status emails", () => {
  it("emails on suspend and on reactivate, but not on a repeat", async () => {
    const token = await asAdmin();
    const broker = await createBroker();

    expect((await post(token, `/manage/brokers/${broker._id}/status`, { status: "suspended" })).status).toBe(200);
    await post(token, `/manage/brokers/${broker._id}/status`, { status: "suspended" });
    expect(emailsTo("broker_suspended")).toHaveLength(1);
    expect(emailsTo("broker_suspended")[0].to).toEqual([{ email: broker.email, name: broker.name }]);

    await post(token, `/manage/brokers/${broker._id}/status`, { status: "approved" });
    expect(emailsTo("broker_reactivated")).toHaveLength(1);
    expect(emailsTo("broker_reactivated")[0].variables).toMatchObject({ referralId: broker.referralId });
    // Reactivation isn't a first approval: no new code email.
    expect(emailsTo("broker_confirmation")).toHaveLength(0);
  });

  it("first approval emails the referral ID only", async () => {
    const token = await asAdmin();
    const broker = await pendingBroker();
    await post(token, `/manage/brokers/${broker._id}/status`, { status: "approved" });
    expect(emailsTo("broker_confirmation")).toHaveLength(1);
    expect(emailsTo("broker_reactivated")).toHaveLength(0);
  });
});

describe("admin: reject a partner application", () => {
  it("refunds the fee, emails the reason and blocks login", async () => {
    const token = await asAdmin();
    const broker = await pendingBroker();

    const res = await post(token, `/manage/brokers/${broker._id}/reject`, { reason: "ID proof is unreadable" });

    expect(res.status).toBe(200);
    expect(res.body.broker.status).toBe("rejected");
    expect(razorpay.payments.refund).toHaveBeenCalledWith("pay_p", expect.objectContaining({ speed: "normal" }));
    const saved = await Broker.findById(broker._id);
    expect(saved.transactions[0]).toMatchObject({ refundId: "rfnd_pay_p", amountRefunded: 501 });
    expect(emailsTo("broker_rejected")[0].variables).toMatchObject({
      reason: "ID proof is unreadable",
      amount: 501,
      refundId: "rfnd_pay_p",
    });

    const login = await api().post("/api/login").send({ email: broker.email, password: PASSWORD, isPartner: true });
    expect(login.status).toBe(403);
    // A session from before the rejection stops working too.
    const me = await api().get("/api/broker/me").set("x-auth-token", tokenFor(broker, "BROKER"));
    expect(me.status).toBe(401);
  });

  it("needs a reason and only works on pending applications", async () => {
    const token = await asAdmin();
    const pending = await pendingBroker();
    expect((await post(token, `/manage/brokers/${pending._id}/reject`, {})).status).toBe(400);

    const approved = await createBroker();
    expect((await post(token, `/manage/brokers/${approved._id}/reject`, { reason: "x" })).status).toBe(400);
    expect(razorpay.payments.refund).not.toHaveBeenCalled();
  });

  it("leaves the application pending if Razorpay refuses the refund", async () => {
    const token = await asAdmin();
    const broker = await pendingBroker();
    vi.mocked(razorpay.payments.refund).mockRejectedValueOnce({ error: { description: "Insufficient balance" } });

    const res = await post(token, `/manage/brokers/${broker._id}/reject`, { reason: "Duplicate" });

    expect(res.status).toBe(400);
    expect(res.body.msg).toBe("Insufficient balance");
    expect((await Broker.findById(broker._id)).status).toBe("pending");
    expect(emailsTo("broker_rejected")).toHaveLength(0);
  });

  it("can't be approved after it was rejected", async () => {
    const token = await asAdmin();
    const broker = await pendingBroker();
    await post(token, `/manage/brokers/${broker._id}/reject`, { reason: "Duplicate" });
    expect((await post(token, `/manage/brokers/${broker._id}/status`, { status: "approved" })).status).toBe(400);
  });

  it("isn't open to partners", async () => {
    const broker = await pendingBroker();
    const partner = tokenFor(await createBroker(), "BROKER");
    const res = await post(partner, `/manage/brokers/${broker._id}/reject`, { reason: "x" });
    expect([401, 403, 404]).toContain(res.status);
    expect((await Broker.findById(broker._id)).status).toBe("pending");
  });
});
