import { beforeEach, describe, expect, it } from "vitest";
import User from "../src/models/User.js";
import upStash from "../src/config/upStash.js";
import { acceptsViewer, acceptsViewerQuery, DEFAULT_STRICT } from "../src/utils/matching.js";
import { api, createUser, paidOrder, registrationForm, tokenFor } from "./helpers.js";

/** A bride whose partner preferences reject the default test groom (B.E, 1995, Never Married). */
const bride = (partner, rest = {}) =>
  createUser({
    basic: { gender: "Female" },
    rest: {
      hasCompleteProfile: true,
      isVerified: true,
      partner: {
        qualification: ["MBBS"],
        martialStatus: ["Divorced"],
        ageFrom: "20",
        ageTo: "25",
        ...partner,
      },
      ...rest,
    },
  });

const groom = (rest = {}) => createUser({ rest: { hasCompleteProfile: true, isVerified: true, ...rest } });

/** Ids of members whose preferences accept `viewer`, by the database query. */
const acceptingIds = async (viewer) => {
  const found = await User.find({ $and: acceptsViewerQuery(viewer) }).select("_id");
  return found.map((u) => String(u._id));
};

/** Ids on the viewer's Matches page, with no filters of their own. */
const feedIds = async (viewer) => {
  const res = await api()
    .post("/api/fetch-profiles")
    .set("x-auth-token", tokenFor(viewer))
    .send({ filters: { partner: {} }, limit: 48 });
  expect(res.status).toBe(200);
  return res.body.profiles.map((p) => String(p._id));
};

const sendInterest = (from, to) =>
  api().post("/api/send-interest").set("x-auth-token", tokenFor(from)).send({ receiverId: String(to._id) });

describe("must-have partner preferences: matching rules", () => {
  it("treats every preference as a must-have for members who never chose", async () => {
    const g = await groom();
    const legacy = await bride();
    const loaded = await User.findById(legacy._id);
    const lean = await User.findById(legacy._id).lean();

    expect(loaded.partner.strict).toBeUndefined();
    expect(lean.partner.strict).toBeUndefined();
    expect(acceptsViewer(loaded, g)).toBe(false);
    expect(acceptsViewer(lean, g)).toBe(false);
    expect(await acceptingIds(g)).not.toContain(String(legacy._id));
  });

  it("only hides the member on the preferences they marked as must-haves", async () => {
    const g = await groom();
    const relaxed = await bride({ strict: [] });
    const ageOnly = await bride({ strict: ["age"] });
    const educationOnly = await bride({ strict: ["qualification"] });
    const maritalOnly = await bride({ strict: ["martialStatus"] });
    const visible = await bride({ strict: ["caste"], caste: ["Brahmin"] });

    const ids = await acceptingIds(g);
    expect(ids).toContain(String(relaxed._id));
    expect(ids).toContain(String(visible._id));
    expect(ids).not.toContain(String(ageOnly._id));
    expect(ids).not.toContain(String(educationOnly._id));
    expect(ids).not.toContain(String(maritalOnly._id));

    for (const [member, ok] of [
      [relaxed, true],
      [visible, true],
      [ageOnly, false],
      [educationOnly, false],
      [maritalOnly, false],
    ]) {
      expect(acceptsViewer(member, g)).toBe(ok);
    }
  });

  it("applies height must-haves only when marked", async () => {
    const tall = await groom({ personal: { height: "180" } });
    const prefs = { qualification: [], martialStatus: [], ageFrom: undefined, ageTo: undefined, heightFrom: "150", heightTo: "170" };
    const strictHeight = await bride({ ...prefs, strict: ["height"] });
    const softHeight = await bride({ ...prefs, strict: ["age", "caste"] });

    const ids = await acceptingIds(tall);
    expect(ids).not.toContain(String(strictHeight._id));
    expect(ids).toContain(String(softHeight._id));
    expect(acceptsViewer(strictHeight, tall)).toBe(false);
    expect(acceptsViewer(softHeight, tall)).toBe(true);
  });

  it("doesn't exclude a viewer on a must-have they haven't filled in", async () => {
    const g = await groom();
    await User.updateOne({ _id: g._id }, { $unset: { "basic.qualification": "" } }, { strict: false });
    const viewer = await User.findById(g._id).lean();
    const member = await bride({ ageFrom: undefined, ageTo: undefined, martialStatus: [], strict: ["qualification"] });

    expect(acceptsViewer(member, viewer)).toBe(true);
    expect(await acceptingIds(viewer)).toContain(String(member._id));
  });

  it("drops unknown must-have keys when saving", async () => {
    const member = await bride({ strict: ["age", "nonsense", "age", "country"] });
    expect([...member.partner.strict]).toEqual(["age", "country"]);
  });
});

describe("must-have partner preferences: through the API", () => {
  it("shows a member on Matches only when the viewer meets their must-haves", async () => {
    const g = await groom();
    const legacy = await bride();
    const soft = await bride({ strict: [] });
    const strict = await bride({ strict: ["qualification"] });

    const ids = await feedIds(g);
    expect(ids).toContain(String(soft._id));
    expect(ids).not.toContain(String(strict._id));
    expect(ids).not.toContain(String(legacy._id));
  });

  it("lets the viewer send interest past preferred-only preferences, not must-haves", async () => {
    const g = await groom();
    const soft = await bride({ strict: ["caste"], caste: ["Brahmin"] });
    const strict = await bride({ strict: ["martialStatus"] });

    expect((await sendInterest(g, soft)).status).toBe(200);
    const blocked = await sendInterest(g, strict);
    expect(blocked.status).toBe(403);
  });

  it("records a profile view only when the viewer meets the must-haves", async () => {
    const g = await groom();
    const soft = await bride({ strict: [] });
    const strict = await bride({ strict: ["age"] });

    for (const target of [soft, strict]) {
      const res = await api().post("/api/profile-view").set("x-auth-token", tokenFor(g)).send({ userId: String(target._id) });
      expect(res.status).toBe(200);
    }
    expect((await User.findById(soft._id)).profileViews).toHaveLength(1);
    expect((await User.findById(strict._id)).profileViews).toHaveLength(0);
  });

  it("saves must-haves from the profile page and keeps them on later saves", async () => {
    const member = await bride();
    const token = tokenFor(member);
    const save = (partner) =>
      api()
        .post("/api/my-profile")
        .set("x-auth-token", token)
        .send({ basic: { fullName: member.basic.fullName }, partner });

    const first = await save({ ageFrom: "20", ageTo: "25", strict: ["age", "bogus", "country"] });
    expect(first.status).toBe(200);
    expect(first.body.profile.partner.strict).toEqual(["age", "country"]);

    // A save that doesn't mention `strict` leaves it alone.
    const second = await save({ ageFrom: "21" });
    expect(second.status).toBe(200);
    expect((await User.findById(member._id)).partner.strict).toEqual(["age", "country"]);

    // Turning everything off is kept as an empty list, not "never chose".
    await save({ strict: [] });
    const relaxed = await User.findById(member._id).lean();
    expect(relaxed.partner.strict).toEqual([]);
  });

  it("lets admins edit a member's must-haves", async () => {
    const admin = await createUser({ rest: { isAdmin: true } });
    const member = await bride();
    const res = await api()
      .post(`/api/manage/users/${member._id}/profile`)
      .set("x-auth-token", tokenFor(admin))
      .send({ partner: { strict: ["caste"] } });

    expect(res.status).toBe(200);
    const saved = await User.findById(member._id);
    expect([...saved.partner.strict]).toEqual(["caste"]);
    expect([...saved.partner.qualification]).toEqual(["MBBS"]); // other preferences untouched
  });

  describe("new members", () => {
    beforeEach(() => upStash.set("upload:asha", "1"));

    it("start with the default must-haves", async () => {
      const order = await api()
        .post("/api/create-order")
        .set("X-Forwarded-For", "10.9.9.9")
        .send({ purpose: "registration", registration: registrationForm() });
      expect(order.status).toBe(200);
      const res = await api().post("/api/user-register").send(paidOrder(order.body.orderId));
      expect(res.status).toBe(200);

      const created = await User.findOne({ "basic.email": "asha@example.test" }).lean();
      expect(created.partner.strict).toEqual(DEFAULT_STRICT);
      expect(created.partner.motherTongue).toEqual(["Kannada"]);
    });
  });
});
