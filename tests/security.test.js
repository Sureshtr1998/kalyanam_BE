import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import upStash, { publishQStash } from "../src/config/upStash.js";
import imageKit from "../src/config/imageKit.js";
import sendEmail from "../src/config/msg91Email.js";
import User from "../src/models/User.js";
import { api, createUser, registrationForm, tokenFor } from "./helpers.js";

let ipSeq = 0;
const freshIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NOT_AN_IMAGE = Buffer.from("<script>alert(1)</script>");

const uploadPhoto = (buf, name = "me.png") =>
  api()
    .post("/api/user-register/upload-images")
    .set("X-Forwarded-For", freshIp())
    .attach("images", buf, { filename: name, contentType: "image/png" });

const internal = (path, body) =>
  api().post(`/api/${path}`).set("x-internal-secret", process.env.INTERNAL_ROUTE_SECRET).send(body);

describe("pre-sign-up photo uploads", () => {
  it("rejects files that only claim to be images", async () => {
    const res = await uploadPhoto(NOT_AN_IMAGE);
    expect(res.status).toBe(400);
  });

  it("remembers real uploads and queues their cleanup", async () => {
    const res = await uploadPhoto(PNG);
    expect(res.status).toBe(200);
    const [{ fileId }] = res.body.media;
    expect(await upStash.get(`upload:${fileId}`)).toBeTruthy();
    expect(publishQStash).toHaveBeenCalledWith("cleanup-uploads", { fileIds: [fileId] }, "4d");
  });

  it("only accepts photos this server issued in a registration", async () => {
    const res = await api()
      .post("/api/create-order")
      .set("X-Forwarded-For", freshIp())
      .send({ purpose: "registration", registration: registrationForm({ images: [{ url: "https://evil.example/x.jpg", fileId: "someone-elses" }] }) });
    expect(res.status).toBe(400);
  });

  it("cleanup deletes unused uploads and keeps ones a member uses", async () => {
    await createUser({ basic: { images: [{ url: "https://ik.example.test/kept.jpg", fileId: "kept" }] } });
    const res = await internal("cleanup-uploads", { fileIds: ["kept", "orphan"] });
    expect(res.body.deleted).toBe(1);
    expect(imageKit.deleteFile).toHaveBeenCalledWith("orphan");
    expect(imageKit.deleteFile).not.toHaveBeenCalledWith("kept");
  });

  it("cleanup is internal only", async () => {
    const res = await api().post("/api/cleanup-uploads").send({ fileIds: ["x"] });
    expect(res.status).toBe(404);
    expect(imageKit.deleteFile).not.toHaveBeenCalled();
  });
});

describe("password reset", () => {
  const requestReset = (email) =>
    api().post("/api/request-reset").set("X-Forwarded-For", freshIp()).send({ email });

  it("answers the same for unknown emails, without sending anything", async () => {
    const user = await createUser();
    const known = await requestReset(user.basic.email);
    const unknown = await requestReset("nobody@example.test");
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("caps reset emails per address, across IPs", async () => {
    const user = await createUser();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await requestReset(user.basic.email)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  const resetTo = async (user, newPassword) => {
    const email = user.basic.email;
    await requestReset(email);
    const { otp } = await upStash.get(`reset_otp:${email}`);
    await api().post("/api/verify-otp").send({ email, otp });
    return api().post("/api/reset-password").send({ email, newPassword });
  };

  it("requires at least 8 characters", async () => {
    const res = await resetTo(await createUser(), "short12");
    expect(res.status).toBe(400);
  });

  it("signs out sessions from before the reset", async () => {
    const user = await createUser();
    const oldToken = jwt.sign(
      { id: user._id, role: "USER", iat: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET
    );
    expect((await api().get("/api/user-account").set("x-auth-token", oldToken)).status).toBe(200);

    expect((await resetTo(user, "NewSecret@123")).status).toBe(200);
    expect(await User.findById(user._id).select("passwordChangedAt")).toHaveProperty("passwordChangedAt");

    expect((await api().get("/api/user-account").set("x-auth-token", oldToken)).status).toBe(401);
    expect((await api().get("/api/user-account").set("x-auth-token", tokenFor(user))).status).toBe(200);
  });
});
