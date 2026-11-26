import { describe, it, expect, beforeEach, vi } from "vitest";
import { publishQStash } from "../src/config/upStash.js";
import User from "../src/models/User.js";
import Settings from "../src/models/Settings.js";
import { AUTO_VERIFY_DELAY_MS } from "../src/utils/autoVerify.js";
import dbConnect from "../src/utils/dbConnect.js";
import { api, createUser, tokenFor } from "./helpers.js";

const internal = (body) =>
  api().post("/api/auto-verify").set("x-internal-secret", process.env.INTERNAL_ROUTE_SECRET).send(body);
const asAdmin = async () => tokenFor(await createUser({ rest: { isAdmin: true } }));
const setMode = (enabled) => Settings.findByIdAndUpdate("global", { autoVerifyHelp: enabled }, { upsert: true });
/** An unverified member who asked for help `hoursAgo` hours ago. */
const helpRequested = (hoursAgo, contact = {}) =>
  createUser({
    rest: {
      isVerified: false,
      verifyHelp: {
        at: new Date(Date.now() - hoursAgo * 3600 * 1000),
        email: contact.email ?? "new.contact@example.test",
        mobile: contact.mobile ?? "9000011111",
      },
    },
  });

describe("verification help and auto-verify mode", () => {
  beforeEach(async () => {
    vi.mocked(publishQStash).mockClear();
    await dbConnect();
    await setMode(false);
  });

  it("records the help request once and queues a check 4 hours later", async () => {
    const user = await createUser({ rest: { isVerified: false } });
    const send = () =>
      api()
        .post("/api/verification-help")
        .set("x-auth-token", tokenFor(user))
        .send({ email: "Help.Me@Example.test", mobile: "9000022222" });

    expect((await send()).status).toBe(200);
    const first = (await User.findById(user._id).lean()).verifyHelp;
    expect(first.email).toBe("help.me@example.test");
    expect(publishQStash).toHaveBeenCalledWith("auto-verify", { userId: String(user._id) }, "14400s");

    expect((await send()).status).toBe(200);
    const second = (await User.findById(user._id).lean()).verifyHelp;
    expect(second.at.getTime()).toBe(first.at.getTime()); // the clock doesn't restart
    expect(publishQStash).toHaveBeenCalledTimes(1);
  });

  it("refuses details another member already uses", async () => {
    const other = await createUser();
    const user = await createUser({ rest: { isVerified: false } });
    const res = await api()
      .post("/api/verification-help")
      .set("x-auth-token", tokenFor(user))
      .send({ email: other.basic.email, mobile: "9000033333" });
    expect(res.status).toBe(400);
  });

  it("does nothing while the mode is off", async () => {
    const user = await helpRequested(5);
    expect((await internal({ userId: String(user._id) })).body.verified).toBe(false);
    expect((await User.findById(user._id).lean()).isVerified).toBe(false);
  });

  it("does nothing before 4 hours", async () => {
    await setMode(true);
    const user = await helpRequested(3);
    await internal({ userId: String(user._id) });
    expect((await User.findById(user._id).lean()).isVerified).toBe(false);
  });

  it("verifies after 4 hours when the mode is on, using the details they asked about", async () => {
    await setMode(true);
    const user = await helpRequested(AUTO_VERIFY_DELAY_MS / 3600000 + 0.1);
    expect((await internal({ userId: String(user._id) })).body.verified).toBe(true);
    const after = await User.findById(user._id).lean();
    expect(after.isVerified).toBe(true);
    expect(after.autoVerifiedAt).toBeTruthy();
    expect(after.basic.email).toBe("new.contact@example.test");
    expect(after.basic.mobile).toBe("9000011111");
    expect(after.verifyHelp?.at).toBeUndefined();
  });

  it("rejects the queued call without the internal secret", async () => {
    expect((await api().post("/api/auto-verify").send({})).status).toBe(404);
  });

  it("lets an admin turn the mode on, which verifies everyone already due", async () => {
    const token = await asAdmin();
    const due = await helpRequested(6, { email: "due@example.test", mobile: "9000044444" });
    const notYet = await helpRequested(1, { email: "soon@example.test", mobile: "9000055555" });

    const res = await api().post("/api/manage/auto-verify").set("x-auth-token", token).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect((await User.findById(due._id).lean()).isVerified).toBe(true);
    expect((await User.findById(notYet._id).lean()).isVerified).toBe(false);

    const off = await api().post("/api/manage/auto-verify").set("x-auth-token", token).send({ enabled: false });
    expect(off.body.enabled).toBe(false);
  });

  it("keeps the switch admin-only", async () => {
    const member = await createUser();
    const res = await api().post("/api/manage/auto-verify").set("x-auth-token", tokenFor(member)).send({ enabled: true });
    expect([401, 403, 404]).toContain(res.status);
  });
});
