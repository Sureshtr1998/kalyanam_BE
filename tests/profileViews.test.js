import { describe, expect, it } from "vitest";
import User from "../src/models/User.js";
import { api, createUser, tokenFor } from "./helpers.js";

const member = (basic = {}, rest = {}) =>
  createUser({ basic, rest: { hasCompleteProfile: true, isVerified: true, ...rest } });

/** A bride whose must-haves reject the default test groom (Never Married, born 1995). */
const pickyBride = () =>
  member({ gender: "Female" }, { partner: { martialStatus: ["Divorced"], ageFrom: "20", ageTo: "25" } });

const as = (user) => ({ "x-auth-token": tokenFor(user) });

const open = (viewer, target) =>
  api().post("/api/profile-view").set(as(viewer)).send({ userId: String(target._id) });

const visitorIds = async (user) => {
  const res = await api().get("/api/profile-views").set(as(user));
  expect(res.status).toBe(200);
  return res.body.activities.map((p) => String(p._id));
};

describe("Viewed you", () => {
  it("lists a member who opened my profile, with the time", async () => {
    const groom = await member();
    const bride = await member({ gender: "Female" });

    expect((await open(groom, bride)).status).toBe(200);

    const res = await api().get("/api/profile-views").set(as(bride));
    expect(res.body.activities.map((p) => String(p._id))).toEqual([String(groom._id)]);
    expect(res.body.activities[0].viewedAt).toBeTruthy();
    expect(res.body.activities[0].basic.mobile).toBeUndefined();
    expect(res.body.activities[0].hideProfiles).toBeUndefined();
  });

  it("does not record a stranger my preferences exclude", async () => {
    const groom = await member();
    const bride = await pickyBride();

    await open(groom, bride);

    expect(await visitorIds(bride)).toEqual([]);
  });

  it("shows the receiver of my interest when they open my profile, even if my preferences exclude them", async () => {
    const groom = await member();
    const bride = await pickyBride();

    const sent = await api()
      .post("/api/send-interest")
      .set(as(bride))
      .send({ receiverId: String(groom._id) });
    expect(sent.status).toBe(200);

    await open(groom, bride);

    expect(await visitorIds(bride)).toEqual([String(groom._id)]);
  });

  it("shows the sender of an interest when they open the receiver's profile after preferences changed", async () => {
    const groom = await member();
    const bride = await member({ gender: "Female" });

    await api().post("/api/send-interest").set(as(groom)).send({ receiverId: String(bride._id) });
    await User.updateOne(
      { _id: bride._id },
      { partner: { martialStatus: ["Divorced"], strict: ["martialStatus"] } }
    );

    await open(groom, bride);

    expect(await visitorIds(await User.findById(bride._id))).toEqual([String(groom._id)]);
  });

  it("keeps blocked members out even when an interest connects them", async () => {
    const groom = await member();
    const bride = await pickyBride();
    await api().post("/api/send-interest").set(as(bride)).send({ receiverId: String(groom._id) });
    await User.updateOne({ _id: bride._id }, { hideProfiles: [groom._id] });

    await open(groom, bride);

    expect(await visitorIds(bride)).toEqual([]);
  });

  it("lists a repeat visitor once, newest view first", async () => {
    const groom = await member();
    const other = await member();
    const bride = await member({ gender: "Female" });

    await open(groom, bride);
    await open(other, bride);
    await open(groom, bride);

    expect(await visitorIds(bride)).toEqual([String(groom._id), String(other._id)]);
  });

  it("lists a visitor once even if stored twice", async () => {
    const groom = await member();
    const bride = await member({ gender: "Female" });
    await User.updateOne(
      { _id: bride._id },
      { profileViews: [{ user: groom._id, at: new Date() }, { user: groom._id, at: new Date(0) }] }
    );

    expect(await visitorIds(bride)).toEqual([String(groom._id)]);
  });
});
