import { afterEach, describe, expect, it, vi } from "vitest";
import { notify } from "../src/config/msg91Email.js";
import { sendWhatsappTemplate } from "../src/ops/whatsapp.js";

vi.mock("../src/ops/whatsapp.js", async (importOriginal) => ({
  ...(await importOriginal()),
  whatsappConfigured: () => true,
  sendWhatsappTemplate: vi.fn(async () => ({})),
}));
import upStash from "../src/config/upStash.js";
import User from "../src/models/User.js";
import DeletedMember from "../src/models/DeletedMember.js";
import {
  LEGACY_END,
  firstEndDate,
  membershipStage,
  reminderDue,
  runMembershipCycle,
} from "../src/utils/membership.js";
import { DEFAULT_PRICING_LEVEL, PRICING_LEVELS } from "../src/utils/pricing.js";
import { PASSWORD, api, createUser, paidOrder, tokenFor } from "./helpers.js";

const DAY = 86400000;
const at = (iso) => new Date(iso);
const setNow = (iso) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(iso));
};
afterEach(() => vi.useRealTimers());

const groom = (rest = {}) => createUser({ rest: { hasCompleteProfile: true, ...rest } });
const bride = (rest = {}) =>
  createUser({ basic: { gender: "Female" }, rest: { hasCompleteProfile: true, partner: { strict: [] }, ...rest } });
const as = (u) => ({ "x-auth-token": tokenFor(u) });
const ids = (res) => (res.body.profiles ?? []).map((p) => String(p._id));

describe("end dates and stages", () => {
  it("starts the first year at the launch for members who joined before it", () => {
    expect(firstEndDate(at("2025-03-10T00:00:00Z"))).toEqual(LEGACY_END);
    expect(firstEndDate(at("2027-02-10T00:00:00Z"))).toEqual(LEGACY_END);
    expect(firstEndDate(at("2027-04-01T00:00:00Z"))).toEqual(at("2028-04-01T00:00:00Z"));
  });

  it("moves through renewal, grace and paused", () => {
    const user = { membershipEndsAt: LEGACY_END };
    expect(membershipStage(user, at("2027-12-01T00:00:00Z"))).toBe("active");
    expect(membershipStage(user, at("2028-02-10T00:00:00Z"))).toBe("renewal");
    expect(membershipStage(user, at("2028-03-05T00:00:00Z"))).toBe("grace");
    expect(membershipStage(user, at("2028-03-20T00:00:00Z"))).toBe("paused");
    expect(membershipStage({ ...user, marriedAt: new Date() }, at("2027-12-01T00:00:00Z"))).toBe("closed");
  });

  it("picks only the most urgent reminder", () => {
    const end = LEGACY_END;
    const off = (days) => new Date(end.getTime() + days * DAY);
    expect(reminderDue(end, off(-40))).toBeNull();
    expect(reminderDue(end, off(-20))).toBe("d30");
    expect(reminderDue(end, off(-5))).toBe("d7");
    expect(reminderDue(end, off(-0.04))).toBe("d1");
    expect(reminderDue(end, off(2))).toBe("d0");
    expect(reminderDue(end, off(20))).toBe("p15");
    expect(reminderDue(end, off(50))).toBeNull();
    expect(reminderDue(end, off(70))).toBe("p60");
  });
});

describe("daily membership job", () => {
  it("before the launch only backfills end dates and hides 90-day inactive profiles", async () => {
    setNow("2026-12-01T05:00:00Z");
    const active = await groom({ lastActiveAt: at("2026-11-20T00:00:00Z") });
    const away = await groom({ lastActiveAt: at("2026-08-01T00:00:00Z") });
    // Joined in 2025, before end dates existed.
    await User.collection.updateMany({}, { $unset: { membershipEndsAt: "" }, $set: { createdAt: at("2025-05-01T00:00:00Z") } });

    const out = await runMembershipCycle();

    expect(out.backfilled).toBe(2);
    expect(out.hiddenInactive).toBe(1);
    const a = await User.findById(active._id);
    const b = await User.findById(away._id);
    expect(a.membershipEndsAt).toEqual(LEGACY_END);
    expect(a.isHidden).toBe(false);
    expect(b.isHidden).toBe(true);
    expect(b.hiddenForInactivityAt).toBeTruthy();
    expect(sendWhatsappTemplate).not.toHaveBeenCalled();
  });

  it("logging in shows an inactivity-hidden profile again", async () => {
    const away = await groom({ isHidden: true, hiddenForInactivityAt: new Date() });
    const res = await api().post("/api/login").send({ email: away.basic.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const fresh = await User.findById(away._id);
    expect(fresh.isHidden).toBe(false);
    expect(fresh.hiddenForInactivityAt).toBeUndefined();
  });

  it("sends each reminder once per end date, and pauses after the grace period", async () => {
    setNow("2028-02-10T05:00:00Z");
    const m = await groom({ lastActiveAt: at("2028-02-09T00:00:00Z"), membershipEndsAt: LEGACY_END });

    let out = await runMembershipCycle();
    expect(out.reminders).toEqual({ d30: 1 });
    out = await runMembershipCycle();
    expect(out.reminders).toEqual({});
    expect(sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendWhatsappTemplate).mock.calls[0][0]).toMatchObject({ name: "membership_ending_30d", language: "en" });
    // {{3}} is the Account page, where the member renews.
    expect(vi.mocked(sendWhatsappTemplate).mock.calls[0][0].components.body_3.value).toMatch(/\/account$/);

    setNow("2028-03-20T05:00:00Z");
    await User.updateOne({ _id: m._id }, { lastActiveAt: new Date() });
    out = await runMembershipCycle();
    expect(out.paused).toBe(1);
    expect(out.reminders).toEqual({ p15: 1 });
    expect((await User.findById(m._id)).isPaused).toBe(true);
  });

  it("does not remind or pause members who closed their profile", async () => {
    setNow("2028-03-20T05:00:00Z");
    const m = await groom({ marriedAt: new Date(), isHidden: true, membershipEndsAt: LEGACY_END });
    const out = await runMembershipCycle();
    expect(out.reminders).toEqual({});
    expect((await User.findById(m._id)).isPaused).toBe(false);
  });

  it("warns twice before deleting a long-dormant account and keeps its payments", async () => {
    setNow("2030-06-01T05:00:00Z");
    const m = await groom({
      isPaused: true,
      membershipEndsAt: LEGACY_END,
      lastActiveAt: at("2027-06-01T00:00:00Z"),
      transactions: [{ orderId: "order_1", paymentId: "pay_1", amountPaid: 351 }],
    });

    expect((await runMembershipCycle()).dormant.warned).toBe(1);
    expect((await runMembershipCycle()).dormant).toMatchObject({ warned: 0, finalWarned: 0, deleted: 0 });

    setNow("2030-06-30T05:00:00Z");
    expect((await runMembershipCycle()).dormant.finalWarned).toBe(1);
    setNow("2030-07-02T06:00:00Z");
    expect((await runMembershipCycle()).dormant.deleted).toBe(1);

    expect(await User.findById(m._id)).toBeNull();
    const kept = await DeletedMember.findOne({ memberId: m._id }).lean();
    expect(kept.transactions[0].paymentId).toBe("pay_1");
  });

  it("starts over when a warned member comes back", async () => {
    setNow("2030-06-01T05:00:00Z");
    const m = await groom({ isPaused: true, membershipEndsAt: LEGACY_END, lastActiveAt: at("2027-06-01T00:00:00Z") });
    await runMembershipCycle();
    await User.updateOne({ _id: m._id }, { lastActiveAt: at("2030-06-02T00:00:00Z") });
    setNow("2030-06-03T05:00:00Z");
    const out = await runMembershipCycle();
    expect(out.dormant.cleared).toBe(1);
    expect((await User.findById(m._id)).dormantWarnedAt).toBeUndefined();
  });
});

describe("what an ended membership limits", () => {
  it("lets grace members browse but not send interests; hides paused members", async () => {
    setNow("2028-03-05T05:00:00Z");
    const g = await groom({ membershipEndsAt: LEGACY_END });
    const b = await bride({ membershipEndsAt: at("2029-03-01T00:00:00Z") });

    const sent = await api().post("/api/send-interest").set(as(g)).send({ receiverId: String(b._id) });
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe("MEMBERSHIP_REQUIRED");

    expect((await api().post("/api/fetch-profiles").set(as(g)).send({})).status).toBe(200);
    const seen = await api().post("/api/fetch-profiles").set(as(b)).send({});
    expect(ids(seen)).toContain(String(g._id));
    // Others see the end date (for the "Membership ending" mark) but nothing private.
    const card = seen.body.profiles.find((p) => String(p._id) === String(g._id));
    expect(card.membershipEndsAt).toBeTruthy();
    expect(card.membershipReminders).toBeUndefined();
    expect(card.marriageNote).toBeUndefined();
    // The bride joined after his end date, so she counts as a new match he is missing.

    setNow("2028-03-20T05:00:00Z");
    await User.updateOne({ _id: g._id }, { isPaused: true });
    expect(ids(await api().post("/api/fetch-profiles").set(as(b)).send({}))).not.toContain(String(g._id));
    expect((await api().post("/api/fetch-profiles").set(as(g)).send({})).status).toBe(403);

    const summary = await api().get("/api/membership").set(as(g));
    expect(summary.body).toMatchObject({ stage: "paused", canRenew: true, newMatches: 1, pendingInterests: 0 });
  });

  it("limits nothing before the launch", async () => {
    setNow("2026-12-01T05:00:00Z");
    const g = await groom();
    const b = await bride();
    const sent = await api().post("/api/send-interest").set(as(g)).send({ receiverId: String(b._id) });
    expect(sent.status).toBe(200);
    const res = await api().get("/api/membership").set(as(g));
    expect(res.body).toMatchObject({ launched: false, stage: "active", canRenew: false });
  });
});

describe("renewal", () => {
  const level = PRICING_LEVELS[DEFAULT_PRICING_LEVEL];

  it("refuses to renew an active membership", async () => {
    setNow("2027-04-01T05:00:00Z");
    const g = await groom({ membershipEndsAt: LEGACY_END });
    const res = await api().post("/api/create-order").set(as(g)).send({ purpose: "renewal" });
    expect(res.status).toBe(400);
  });

  it("charges the renewal fee and adds a year from the old end date", async () => {
    setNow("2028-02-20T05:00:00Z");
    const g = await groom({ membershipEndsAt: LEGACY_END });
    const order = await api().post("/api/create-order").set(as(g)).send({ purpose: "renewal" });
    expect(order.status).toBe(200);
    expect(order.body.amount).toBe(level.renewalFee * 100);

    const done = await api().post("/api/renew-membership").set(as(g)).send(paidOrder(order.body.orderId));
    expect(done.status).toBe(200);
    const again = await api().post("/api/renew-membership").set(as(g)).send(paidOrder(order.body.orderId));
    expect(again.body.alreadyApplied).toBe(true);

    const fresh = await User.findById(g._id);
    expect(fresh.membershipEndsAt).toEqual(at("2029-02-28T18:29:59.999Z"));
    expect(fresh.interests.totalNoOfInterest).toBe(36 + level.renewalInterests);
    expect(fresh.transactions[0].note).toBe("Membership renewal");
    expect(fresh.transactions).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ template_id: "membership_renewed" }));
    expect(await upStash.get(`rzp_order:${order.body.orderId}`)).toMatchObject({ fulfilled: true });
  });

  it("renews a paused member from today and shows them again", async () => {
    setNow("2028-09-01T05:00:00Z");
    const g = await groom({ membershipEndsAt: LEGACY_END, isPaused: true });
    const order = await api().post("/api/create-order").set(as(g)).send({ purpose: "renewal" });
    await api().post("/api/renew-membership").set(as(g)).send(paidOrder(order.body.orderId));
    const fresh = await User.findById(g._id);
    expect(fresh.isPaused).toBe(false);
    expect(fresh.membershipEndsAt).toEqual(at("2029-09-01T05:00:00Z"));
  });
});

describe("marriage fixed", () => {
  it("closes and hides the profile; login does not reopen it, reopen does", async () => {
    const g = await groom();
    await api().post("/api/membership/close").set(as(g)).send({ note: "Found my match here" });
    let fresh = await User.findById(g._id);
    expect(fresh.isHidden).toBe(true);
    expect(fresh.marriageNote).toBe("Found my match here");

    await api().post("/api/login").send({ email: g.basic.email, password: PASSWORD });
    expect((await User.findById(g._id)).isHidden).toBe(true);

    const res = await api().post("/api/membership/reopen").set(as(g));
    expect(res.status).toBe(200);
    fresh = await User.findById(g._id);
    expect(fresh.isHidden).toBe(false);
    expect(fresh.marriedAt).toBeUndefined();
  });
});
