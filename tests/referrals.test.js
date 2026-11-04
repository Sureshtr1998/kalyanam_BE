import { beforeEach, describe, expect, it, vi } from "vitest";
import razorpay from "../src/config/razorpay.js";
import { notify } from "../src/config/msg91Email.js";
import upStash from "../src/config/upStash.js";
import User from "../src/models/User.js";
import { DEFAULT_PRICING_LEVEL, PRICING_LEVELS } from "../src/utils/pricing.js";
import { pickRefundablePayment } from "../src/utils/referrals.js";
import { api, createBroker, createUser, paidOrder, registrationForm, tokenFor } from "./helpers.js";

const { referralFee, registrationFee, memberReferralReward } = PRICING_LEVELS[DEFAULT_PRICING_LEVEL];

beforeEach(() => upStash.set("upload:asha", "1"));

let ipSeq = 0;
const createOrder = (body) =>
  api()
    .post("/api/create-order")
    .set("X-Forwarded-For", `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`)
    .send(body);

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** A member with a paid registration and their own refer & earn code. */
const referrer = (transactions) =>
  createUser({
    rest: {
      referralCode: "REFMEM2",
      transactions: transactions ?? [
        { orderId: "order_ref", paymentId: "pay_ref", amountPaid: registrationFee, note: "Registration", dateOfTrans: daysAgo(10) },
      ],
    },
  });

const registerWith = async (code) => {
  const order = await createOrder({ purpose: "registration", registration: registrationForm({ referralId: code }) });
  expect(order.status).toBe(200);
  const res = await api().post("/api/user-register").send(paidOrder(order.body.orderId));
  expect(res.status).toBe(200);
  return { order, friend: await User.findOne({ "basic.email": "asha@example.test" }) };
};

describe("GET /referral", () => {
  it("creates a code for an older member and shows the live offer", async () => {
    const member = await createUser();
    const res = await api().get("/api/referral").set("x-auth-token", tokenFor(member));
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[A-Z2-9]{7}$/);
    expect(res.body).toMatchObject({
      reward: memberReferralReward,
      discount: registrationFee - referralFee,
      friendFee: referralFee,
      totals: { joined: 0, paid: 0, pending: 0 },
    });
    // Stable across calls.
    const again = await api().get("/api/referral").set("x-auth-token", tokenFor(member));
    expect(again.body.code).toBe(res.body.code);
    expect((await User.findById(member._id)).referralCode).toBe(res.body.code);
  });

  it("is for members only", async () => {
    expect((await api().get("/api/referral")).status).toBe(401);
  });
});

describe("registering with a member's code", () => {
  it("validates the code", async () => {
    await referrer();
    expect((await api().get("/api/validate-referral/refmem2")).body.valid).toBe(true);
    expect((await api().get("/api/validate-referral/NOPE999")).body.valid).toBe(false);
  });

  it("gives the friend the discount and refunds the reward to the referrer's payment", async () => {
    const member = await referrer();
    const { order, friend } = await registerWith("REFMEM2");

    expect(order.body.amount).toBe(referralFee * 100);
    expect(friend.referredBy.toString()).toBe(member._id.toString());
    expect(friend.referredByCode).toBe("REFMEM2");
    // Member codes never count as partner referrals.
    expect(friend.basic.referralId).toBeUndefined();
    expect(friend.referralCode).toMatch(/^[A-Z2-9]{7}$/);

    expect(razorpay.payments.refund).toHaveBeenCalledWith(
      "pay_ref",
      expect.objectContaining({ amount: memberReferralReward * 100, speed: "normal" })
    );
    const after = await User.findById(member._id);
    expect(after.referralRewards).toHaveLength(1);
    expect(after.referralRewards[0]).toMatchObject({ amount: memberReferralReward, status: "paid", refundId: "rfnd_pay_ref" });
    expect(after.transactions[0].referralRefunded).toBe(memberReferralReward);

    // The referrer is emailed the friend's name only.
    const mail = vi.mocked(notify).mock.calls.find(([o]) => o.template_id === "referral_joined")?.[0];
    expect(mail).toMatchObject({
      to: [{ email: member.basic.email }],
      variables: { userName: member.basic.fullName, friendName: "Asha Rao", amount: memberReferralReward },
    });
    expect(Object.keys(mail.variables).sort()).toEqual(["amount", "friendName", "userName"]);

    const tab = await api().get("/api/referral").set("x-auth-token", tokenFor(after));
    expect(tab.body.totals).toEqual({ joined: 1, paid: memberReferralReward, pending: 0 });
    expect(tab.body.rewards[0].friendName).toBe("Asha");
  });

  it("pays once even when the registration is fulfilled twice", async () => {
    const member = await referrer();
    const { order } = await registerWith("REFMEM2");
    await api().post("/api/user-register").send(paidOrder(order.body.orderId));
    expect(razorpay.payments.refund).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls.filter(([o]) => o.template_id === "referral_joined")).toHaveLength(1);
    expect((await User.findById(member._id)).referralRewards).toHaveLength(1);
  });

  it("keeps the reward pending when there is no payment to refund to", async () => {
    const member = await referrer([]);
    await registerWith("REFMEM2");
    expect(razorpay.payments.refund).not.toHaveBeenCalled();
    expect((await User.findById(member._id)).referralRewards[0]).toMatchObject({ status: "pending" });
  });

  it("releases the reserved amount when Razorpay refuses", async () => {
    const member = await referrer();
    vi.mocked(razorpay.payments.refund).mockRejectedValueOnce({ error: { description: "Insufficient balance" } });
    const { friend } = await registerWith("REFMEM2");
    expect(friend).toBeTruthy();
    const after = await User.findById(member._id);
    expect(after.referralRewards[0]).toMatchObject({ status: "pending", note: "Insufficient balance" });
    expect(after.transactions[0].referralRefunded).toBe(0);
  });

  it("still prefers partner codes", async () => {
    const broker = await createBroker();
    const { friend } = await registerWith(broker.referralId);
    expect(friend.basic.referralId).toBe(broker.referralId);
    expect(friend.referredBy).toBeUndefined();
    expect(razorpay.payments.refund).not.toHaveBeenCalled();
  });
});

describe("pickRefundablePayment", () => {
  const t = (o) => ({ paymentId: "p", amountPaid: 351, dateOfTrans: daysAgo(1), note: "Interest Purchase", ...o });

  it("prefers the registration payment, then the newest", () => {
    const list = [t({ paymentId: "new", dateOfTrans: daysAgo(1) }), t({ paymentId: "reg", note: "Registration", dateOfTrans: daysAgo(30) })];
    expect(pickRefundablePayment(list, 71).paymentId).toBe("reg");
  });

  it("skips old, refunded, admin and exhausted payments", () => {
    expect(
      pickRefundablePayment(
        [
          t({ dateOfTrans: daysAgo(200) }),
          t({ refundedAt: new Date() }),
          t({ paymentId: undefined }),
          t({ referralRefunded: 300 }),
        ],
        71
      )
    ).toBeNull();
  });
});

describe("admin: refer & earn rewards", () => {
  const owed = async () => {
    const member = await referrer([]);
    await registerWith("REFMEM2");
    return User.findById(member._id);
  };

  it("shows rewards and lists members who are owed one", async () => {
    const admin = await createUser({ rest: { isAdmin: true } });
    const member = await owed();
    const detail = await api().get(`/api/manage/users/${member._id}`).set("x-auth-token", tokenFor(admin));
    expect(detail.body.member.referralRewards).toHaveLength(1);
    const list = await api().get("/api/manage/users?status=referralRewardDue").set("x-auth-token", tokenFor(admin));
    expect(JSON.stringify(list.body)).toContain(String(member._id));
  });

  it("marks a reward paid by hand, once", async () => {
    const admin = await createUser({ rest: { isAdmin: true } });
    const member = await owed();
    const rewardId = String(member.referralRewards[0]._id);
    const pay = () =>
      api().post(`/api/manage/users/${member._id}/referral-reward`).set("x-auth-token", tokenFor(admin)).send({ rewardId });
    expect((await pay()).status).toBe(200);
    expect((await User.findById(member._id)).referralRewards[0]).toMatchObject({ status: "paid" });
    expect((await pay()).status).toBe(400);
  });

  it("is admin only", async () => {
    const member = await owed();
    const other = await createUser();
    const res = await api()
      .post(`/api/manage/users/${member._id}/referral-reward`)
      .set("x-auth-token", tokenFor(other))
      .send({ rewardId: String(member.referralRewards[0]._id) });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect((await User.findById(member._id)).referralRewards[0].status).toBe("pending");
  });
});
