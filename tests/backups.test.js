import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import imageKit from "../src/config/imageKit.js";
import { api, createUser, createBroker, PASSWORD, tokenFor } from "./helpers.js";
import User from "../src/models/User.js";
import { decrypt, encrypt, isEncrypted, parseBackup, serialize } from "../src/utils/backup.js";

/** In-memory stand-in for the ImageKit folder that holds backups. */
const cloud = new Map();
let seq = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  cloud.clear();
  process.env.BACKUP_SECRET = "test-backup-secret-0123456789";
  process.env.CRON_SECRET = "cron-test";
  vi.mocked(imageKit.upload).mockImplementation(async (opts) => {
    const fileId = `bk_${++seq}`;
    const file = {
      fileId,
      name: opts.fileName,
      filePath: `${opts.folder}/${opts.fileName}`,
      url: `https://ik.example.test/${fileId}`,
      tags: opts.tags,
      size: /** @type {Buffer} */ (opts.file).length,
      createdAt: new Date(Date.now() + seq).toISOString(),
      isPrivateFile: !!opts.isPrivateFile,
      body: opts.file,
    };
    cloud.set(fileId, file);
    return file;
  });
  vi.mocked(imageKit.listFiles).mockImplementation(async () => [...cloud.values()]);
  vi.mocked(imageKit.getFileDetails).mockImplementation(async (id) => {
    if (!cloud.has(id)) throw new Error("not found");
    return cloud.get(id);
  });
  vi.mocked(imageKit.deleteFile).mockImplementation(async (id) => void cloud.delete(id));
  globalThis.fetch = vi.fn(async (url) => {
    const file = [...cloud.values()].find((f) => f.url === String(url));
    return file ? new Response(file.body) : new Response("missing", { status: 404 });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BACKUP_SECRET;
  delete process.env.BACKUP_KEEP;
});

const asAdmin = async () => {
  const admin = await createUser({ rest: { isAdmin: true } });
  return { admin, token: tokenFor(admin) };
};

const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("backup file format", () => {
  it("round-trips ObjectIds and dates, and rejects tampering", async () => {
    const id = new mongoose.Types.ObjectId();
    const { buffer } = await serialize({ things: [{ _id: id, at: new Date("2026-01-02T03:04:05Z"), n: 1 }] }, { reason: "manual" });
    const { collections, header } = await parseBackup(encrypt(buffer));
    expect(header.counts).toEqual({ things: 1 });
    expect(collections.things[0]._id.equals(id)).toBe(true);
    expect(collections.things[0].at).toBeInstanceOf(Date);

    const text = zlib.gunzipSync(buffer).toString().replace('"n":{"$numberInt":"1"}', '"n":{"$numberInt":"2"}');
    await expect(parseBackup(zlib.gzipSync(text))).rejects.toThrow(/integrity/);
  });

  it("can't be decrypted with another secret", async () => {
    const { buffer } = await serialize({ a: [] }, { reason: "manual" });
    const enc = encrypt(buffer);
    expect(isEncrypted(enc)).toBe(true);
    expect(() => decrypt(enc, "some-other-secret-value")).toThrow(/BACKUP_SECRET/);
  });
});

describe("admin backups", () => {
  it("is hidden from non-admins", async () => {
    const member = await createUser();
    const res = await api().get("/api/manage/backups").set("x-auth-token", tokenFor(member));
    expect(res.status).toBe(404);
  });

  it("takes an encrypted cloud backup and downloads it as plain .json.gz", async () => {
    const { token } = await asAdmin();
    await createUser();
    const made = await api().post("/api/manage/backups").set("x-auth-token", token);
    expect(made.status).toBe(200);
    expect(made.body.header.counts.users).toBe(2);
    expect(isEncrypted(cloud.get(made.body.backup.id).body)).toBe(true);

    const list = await api().get("/api/manage/backups").set("x-auth-token", token);
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.backups[0]).toMatchObject({ reason: "manual", docs: 2 });

    const dl = await api().get(`/api/manage/backups/${made.body.backup.id}/download`).set("x-auth-token", token).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    const { header } = await parseBackup(dl.body);
    expect(header.counts.users).toBe(2);
  });

  it("keeps only the newest BACKUP_KEEP backups", async () => {
    process.env.BACKUP_KEEP = "3";
    const { token } = await asAdmin();
    for (let i = 0; i < 5; i++) await api().post("/api/manage/backups").set("x-auth-token", token);
    expect(cloud.size).toBe(3);
  });

  it("doesn't prune when the new backup has far fewer documents", async () => {
    process.env.BACKUP_KEEP = "2";
    const { admin, token } = await asAdmin();
    for (let i = 0; i < 25; i++) await createUser();
    await api().post("/api/manage/backups").set("x-auth-token", token);
    await api().post("/api/manage/backups").set("x-auth-token", token);
    await User.deleteMany({ _id: { $ne: admin._id } });
    const res = await api().post("/api/manage/backups").set("x-auth-token", token);
    expect(res.body.warning).toMatch(/far fewer/);
    expect(cloud.size).toBe(3);
  });

  it("restores only with the preview token, password and confirm word, after a safety copy", async () => {
    const { admin, token } = await asAdmin();
    const keep = await createUser();
    await createBroker();
    const made = await api().post("/api/manage/backups").set("x-auth-token", token);

    // Disaster: a member is deleted and another is added.
    await User.deleteOne({ _id: keep._id });
    const stray = await createUser();

    const preview = await api().post("/api/manage/backups/preview").set("x-auth-token", token).send({ id: made.body.backup.id });
    expect(preview.status).toBe(200);
    expect(preview.body.collections.find((c) => c.name === "users")).toMatchObject({ backup: 2, current: 2 });

    const restore = (body) => api().post("/api/manage/backups/restore").set("x-auth-token", token).send(body);
    const good = { token: preview.body.token, password: PASSWORD, confirm: "RESTORE", collections: ["users"] };

    expect((await restore({ ...good, password: "wrong" })).status).toBe(400);
    expect((await restore({ ...good, confirm: "restore pls" })).status).toBe(400);
    expect((await restore({ ...good, token: "nope" })).status).toBe(400);
    expect(await User.exists({ _id: keep._id })).toBeNull();

    const done = await restore(good);
    expect(done.status).toBe(200);
    expect(done.body.restored.users).toEqual({ deleted: 2, inserted: 2 });
    expect(await User.exists({ _id: keep._id })).toBeTruthy();
    expect(await User.exists({ _id: stray._id })).toBeNull();
    expect(await User.exists({ _id: admin._id })).toBeTruthy();
    // The pre-restore safety copy holds the state just before.
    expect([...cloud.values()].some((f) => f.tags.includes("prerestore"))).toBe(true);
    // Tokens are single-use.
    expect((await restore(good)).status).toBe(400);
  });

  it("locks restores after 5 wrong passwords", async () => {
    const { token } = await asAdmin();
    const made = await api().post("/api/manage/backups").set("x-auth-token", token);
    const preview = await api().post("/api/manage/backups/preview").set("x-auth-token", token).send({ id: made.body.backup.id });
    const body = { token: preview.body.token, password: "wrong", confirm: "RESTORE", collections: ["users"] };
    for (let i = 0; i < 5; i++) await api().post("/api/manage/backups/restore").set("x-auth-token", token).send(body);
    const res = await api().post("/api/manage/backups/restore").set("x-auth-token", token).send({ ...body, password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it("refuses to restore if the safety copy can't be saved", async () => {
    const { token } = await asAdmin();
    const made = await api().post("/api/manage/backups").set("x-auth-token", token);
    const preview = await api().post("/api/manage/backups/preview").set("x-auth-token", token).send({ id: made.body.backup.id });
    vi.mocked(imageKit.upload).mockRejectedValue(new Error("ImageKit down"));
    const extra = await createUser();
    const res = await api()
      .post("/api/manage/backups/restore")
      .set("x-auth-token", token)
      .send({ token: preview.body.token, password: PASSWORD, confirm: "RESTORE", collections: ["users"] });
    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/nothing was changed/i);
    expect(await User.exists({ _id: extra._id })).toBeTruthy();
  });

  it("restores from an uploaded file, which must match the previewed one", async () => {
    const { token } = await asAdmin();
    const gone = await createUser();
    const exported = await api().get("/api/manage/backups/export").set("x-auth-token", token).buffer(true).parse(binary);
    await User.deleteOne({ _id: gone._id });

    const preview = await api()
      .post("/api/manage/backups/preview")
      .set("x-auth-token", token)
      .attach("backup", exported.body, "backup.json.gz");
    expect(preview.status).toBe(200);

    const other = (await serialize({ users: [] }, { reason: "manual" })).buffer;
    const send = (file) =>
      api()
        .post("/api/manage/backups/restore")
        .set("x-auth-token", token)
        .field("token", preview.body.token)
        .field("password", PASSWORD)
        .field("confirm", "RESTORE")
        .field("collections", JSON.stringify(["users"]))
        .attach("backup", file, "backup.json.gz");

    const wrong = await send(other);
    expect(wrong.status).toBe(400);
    expect(wrong.body.msg).toMatch(/isn't the backup you previewed/);

    const ok = await send(exported.body);
    expect(ok.status).toBe(200);
    expect(await User.exists({ _id: gone._id })).toBeTruthy();
  });

  it("runs the daily cron only with the secret, once a day", async () => {
    await createUser();
    expect((await api().get("/api/cron/db-backup")).status).toBe(401);
    const first = await api().get("/api/cron/db-backup").set("authorization", "Bearer cron-test");
    expect(first.body.ok).toBe(true);
    const second = await api().get("/api/cron/db-backup").set("authorization", "Bearer cron-test");
    expect(second.body.skipped).toBe(true);
    expect(cloud.size).toBe(1);
  });
});
