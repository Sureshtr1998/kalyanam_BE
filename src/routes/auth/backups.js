import crypto from "node:crypto";
import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import bcrypt from "bcryptjs";
import { adminOnly, staffAuth } from "../../middleware/auth.js";
import upStash from "../../config/upStash.js";
import {
  BackupError,
  encryptionConfigured,
  liveCounts,
  parseBackup,
  restoreCollections,
  serialize,
  snapshot,
  stamp,
  toPlainGzip,
} from "../../utils/backup.js";
import { createCloudBackup, fetchBackupFile, keepCount, listBackups } from "../../utils/backupStore.js";

/*
 * Admin → Backups. Take, list, download and restore whole-database backups.
 *
 * Restoring is guarded on purpose:
 *  1. preview first: the backup is fully verified (checksum, counts) and the
 *     admin sees what will change; this issues a 15-minute restore token
 *  2. the restore needs that token, the admin's own password, and the word
 *     RESTORE typed out; 5 wrong passwords lock restores for an hour
 *  3. the backup is re-read and must match the previewed checksum
 *  4. a safety copy of the current database is saved to the cloud first; if
 *     that fails, nothing is touched
 *  5. if writing fails part-way, the safety copy is written back automatically
 *  6. only one backup/restore runs at a time
 */

const router = Router();
router.use("/manage/backups", staffAuth, adminOnly);

const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } });

const LOCK_KEY = "backup:lock";
const TOKEN_PREFIX = "backup:restore:";
const FAIL_PREFIX = "backup:pwfail:";
const TOKEN_SECONDS = 15 * 60;
const MAX_PASSWORD_FAILS = 5;
export const CONFIRM_WORD = "RESTORE";

const db = () => mongoose.connection.db;
const adminLabel = (req) => req.user?.basic?.email ?? "admin";

const withLock = async (fn) => {
  const got = await upStash.set(LOCK_KEY, "1", { nx: true, ex: 300 }).catch(() => "OK");
  if (got !== "OK") throw Object.assign(new BackupError("Another backup or restore is running. Try again in a few minutes."), { status: 409 });
  try {
    return await fn();
  } finally {
    await upStash.del(LOCK_KEY).catch(() => {});
  }
};

const fail = (res, err, fallback) => {
  if (err instanceof BackupError) return res.status(err.status ?? 400).json({ msg: err.message });
  console.error(fallback, err);
  return res.status(500).json({ msg: fallback });
};

const sendGzip = (res, buffer, createdAt) => {
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="kalyanam-backup_${stamp(createdAt)}.json.gz"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(buffer);
};

router.get("/manage/backups", async (_req, res) => {
  const base = { cloud: encryptionConfigured(), keep: keepCount(), confirmWord: CONFIRM_WORD, counts: await liveCounts(db()) };
  if (!base.cloud) return res.json({ ...base, backups: [] });
  try {
    return res.json({ ...base, backups: await listBackups() });
  } catch (err) {
    console.error("Listing backups failed:", err);
    return res.json({ ...base, backups: [], listError: "Couldn't reach the backup storage right now." });
  }
});

/** Take a backup now and keep it in the cloud. */
router.post("/manage/backups", async (req, res) => {
  try {
    const result = await withLock(() => createCloudBackup(db(), { reason: "manual", createdBy: adminLabel(req) }));
    return res.json({ ...result, msg: "Backup saved" });
  } catch (err) {
    return fail(res, err, "Couldn't take the backup");
  }
});

/** Download the current database straight away (nothing is stored). */
router.get("/manage/backups/export", async (req, res) => {
  try {
    const { buffer, header } = await serialize(await snapshot(db()), {
      reason: "download",
      createdBy: adminLabel(req),
      database: db().databaseName,
    });
    return sendGzip(res, buffer, header.createdAt);
  } catch (err) {
    return fail(res, err, "Couldn't export the database");
  }
});

/** Download a stored backup as a plain .json.gz. */
router.get("/manage/backups/:id/download", async (req, res) => {
  try {
    const { buffer, meta } = await fetchBackupFile(req.params.id);
    return sendGzip(res, toPlainGzip(buffer), meta.createdAt);
  } catch (err) {
    return fail(res, err, "Couldn't download the backup");
  }
});

/** Reads the backup a restore request points at: a stored one by id, or an uploaded file. */
const loadSource = async (req) => {
  if (req.file) return { buffer: req.file.buffer, source: { type: "file", name: req.file.originalname } };
  const id = String(req.body?.id || "");
  if (!id) throw new BackupError("Choose a backup or upload a backup file.");
  const { buffer, meta } = await fetchBackupFile(id);
  return { buffer, source: { type: "cloud", id, name: meta.name } };
};

const parseNames = (raw) => {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** Step 1: verify a backup and show what restoring it would change. */
router.post("/manage/backups/preview", upload.single("backup"), async (req, res) => {
  try {
    const { buffer, source } = await loadSource(req);
    const { header } = await parseBackup(buffer);
    const current = await liveCounts(db());
    const names = [...new Set([...Object.keys(header.counts), ...Object.keys(current)])].sort();
    const collections = names.map((name) => ({
      name,
      backup: header.counts[name] ?? null,
      current: current[name] ?? 0,
    }));

    const warnings = [];
    const ageDays = (Date.now() - Date.parse(header.createdAt)) / 86400000;
    if (ageDays > 2) warnings.push(`This backup is ${Math.floor(ageDays)} days old. Anything that happened since then (sign-ups, payments, edits) will be lost in the collections you restore.`);
    if (header.database && header.database !== db().databaseName) {
      warnings.push(`It was taken from the "${header.database}" database, and you're restoring into "${db().databaseName}".`);
    }
    const shrinking = collections.filter((c) => c.backup !== null && c.backup < c.current);
    if (shrinking.length) {
      warnings.push(`These collections have more documents now than in the backup: ${shrinking.map((c) => `${c.name} (${c.current} → ${c.backup})`).join(", ")}.`);
    }

    const token = crypto.randomBytes(24).toString("hex");
    await upStash.set(
      `${TOKEN_PREFIX}${token}`,
      JSON.stringify({ adminId: String(req.user._id), source, checksum: header.checksum }),
      { ex: TOKEN_SECONDS }
    );
    return res.json({ token, expiresIn: TOKEN_SECONDS, source, header, collections, warnings, confirmWord: CONFIRM_WORD });
  } catch (err) {
    return fail(res, err, "Couldn't read the backup");
  }
});

/** Step 2: restore. Needs the preview token, the admin's password and the confirm word. */
router.post("/manage/backups/restore", upload.single("backup"), async (req, res) => {
  const adminId = String(req.user._id);
  try {
    const tokenKey = `${TOKEN_PREFIX}${String(req.body?.token || "")}`;
    const raw = await upStash.get(tokenKey);
    const ticket = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!ticket || ticket.adminId !== adminId) {
      return res.status(400).json({ msg: "This restore has expired. Preview the backup again." });
    }

    const failKey = `${FAIL_PREFIX}${adminId}`;
    const fails = Number(await upStash.get(failKey)) || 0;
    if (fails >= MAX_PASSWORD_FAILS) {
      return res.status(429).json({ msg: "Too many wrong passwords. Restores are locked for an hour." });
    }
    // 400, not 401: a 401 would sign the admin out of the panel.
    if (!(await bcrypt.compare(String(req.body?.password || ""), req.user.basic.password))) {
      await upStash.set(failKey, String(fails + 1), { ex: 3600 });
      return res.status(400).json({ msg: `Wrong password. ${MAX_PASSWORD_FAILS - fails - 1} tries left.` });
    }
    await upStash.del(failKey);

    if (String(req.body?.confirm || "").trim() !== CONFIRM_WORD) {
      return res.status(400).json({ msg: `Type ${CONFIRM_WORD} to confirm.` });
    }

    const result = await withLock(async () => {
      // Re-read the backup; it must be exactly the one that was previewed.
      if (ticket.source.type === "cloud") req.body.id = ticket.source.id;
      else if (!req.file) throw new BackupError("Attach the same backup file again.");
      const { buffer } = await loadSource(req);
      const { header, collections } = await parseBackup(buffer);
      if (header.checksum !== ticket.checksum) {
        throw new BackupError("This isn't the backup you previewed. Preview it again.");
      }

      const names = parseNames(req.body?.collections);
      if (!names.length) throw new BackupError("Choose at least one collection to restore.");
      const unknown = names.filter((n) => !(n in collections));
      if (unknown.length) throw new BackupError(`Not in this backup: ${unknown.join(", ")}`);

      // Safety copy of the current data. No safety copy, no restore.
      const before = await snapshot(db());
      let safety;
      try {
        safety = await createCloudBackup(db(), { reason: "pre-restore", createdBy: adminLabel(req) }, before);
      } catch (err) {
        console.error("Pre-restore backup failed:", err);
        throw new BackupError(
          err instanceof BackupError
            ? `${err.message} Nothing was changed.`
            : "Couldn't save a safety copy of the current data, so nothing was changed. Try again later."
        );
      }

      try {
        const restored = await restoreCollections(db(), collections, names);
        return { restored, safetyBackup: safety.backup, from: header.createdAt };
      } catch (err) {
        console.error("Restore failed, rolling back:", err);
        try {
          await restoreCollections(db(), before, names.filter((n) => n in before));
          throw new BackupError("The restore failed part-way, so the data was put back as it was. Nothing changed.");
        } catch (rollbackErr) {
          if (rollbackErr instanceof BackupError) throw rollbackErr;
          console.error("Rollback failed:", rollbackErr);
          throw Object.assign(
            new BackupError(`The restore failed AND putting the old data back failed. Restore the safety backup "${safety.backup.name}" from this page.`),
            { status: 500 }
          );
        }
      }
    });

    await upStash.del(tokenKey).catch(() => {});
    console.warn(`[backup] ${adminLabel(req)} restored ${Object.keys(result.restored).join(", ")} from ${result.from}`);
    return res.json({ ...result, msg: "Restore complete" });
  } catch (err) {
    return fail(res, err, "Couldn't restore the backup");
  }
});

/**
 * Daily backup, called by Vercel Cron (see vercel.json). Vercel sends
 * `Authorization: Bearer <CRON_SECRET>`. Skipped if one was taken in the
 * last 20 hours.
 */
router.get("/cron/db-backup", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(String(req.header("authorization") || ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ msg: "Unauthorized" });
  }
  try {
    const latest = (await listBackups()).find((b) => b.reason !== "pre-restore");
    if (latest && Date.now() - Date.parse(latest.createdAt) < 20 * 3600 * 1000) {
      return res.json({ skipped: true, latest: latest.createdAt });
    }
    const result = await withLock(() => createCloudBackup(db(), { reason: "scheduled", createdBy: "cron" }));
    if (result.warning) console.warn("[backup]", result.warning);
    return res.json({ ok: true, backup: result.backup, pruned: result.pruned, warning: result.warning });
  } catch (err) {
    return fail(res, err, "Scheduled backup failed");
  }
});

export default router;
