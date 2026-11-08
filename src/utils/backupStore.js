import imageKit from "../config/imageKit.js";
import { BackupError, encrypt, encryptionConfigured, snapshot, serialize, stamp } from "./backup.js";

/*
 * Cloud copies of database backups, kept in ImageKit (already used for
 * photos, so there is nothing new to sign up for). Files are encrypted before
 * upload, uploaded as private files where the plan allows it, and only the
 * newest BACKUP_KEEP (default 7) are kept.
 */

export const FOLDER = "/db_backups";
const TAG = "kbak";
export const keepCount = () => Math.min(Math.max(Number(process.env.BACKUP_KEEP) || 7, 2), 30);

/**
 * @typedef {object} StoredBackup
 * @property {string} id
 * @property {string} name
 * @property {string} createdAt
 * @property {number} size
 * @property {string} reason  manual | scheduled | pre-restore
 * @property {number|null} docs
 */

/** @returns {StoredBackup} */
const toStored = (f) => {
  const tags = f.tags ?? [];
  const docs = tags.find((t) => /^d\d+$/.test(t));
  return {
    id: f.fileId,
    name: f.name,
    createdAt: f.createdAt,
    size: f.size,
    reason: ["manual", "scheduled", "prerestore"].find((r) => tags.includes(r))?.replace("prerestore", "pre-restore") ?? "manual",
    docs: docs ? Number(docs.slice(1)) : null,
  };
};

/** Newest first. */
export const listBackups = async () => {
  const files = await imageKit.listFiles({ path: FOLDER, tags: TAG, sort: "DESC_CREATED", limit: 100, type: "file" });
  return files
    .filter((f) => "fileId" in f && (f.tags ?? []).includes(TAG))
    .map(toStored)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
};

const uploadEncrypted = async (buffer, header) => {
  const options = {
    file: encrypt(buffer),
    fileName: `backup_${stamp(header.createdAt)}_${header.reason}.kbak`,
    folder: FOLDER,
    useUniqueFileName: true,
    tags: [TAG, header.reason.replace("-", ""), `d${header.totalDocs}`],
  };
  try {
    return await imageKit.upload({ ...options, isPrivateFile: true });
  } catch (err) {
    // Private files may not be on every plan; the file is encrypted either way.
    console.warn("Private backup upload failed, retrying as a normal file:", err?.message);
    return imageKit.upload(options);
  }
};

/** Downloads a stored (encrypted) backup file. */
export const fetchBackupFile = async (id) => {
  let file;
  try {
    file = await imageKit.getFileDetails(id);
  } catch {
    throw new BackupError("That backup no longer exists.");
  }
  if (!file?.filePath?.startsWith(`${FOLDER}/`)) throw new BackupError("That backup no longer exists.");
  const url = file.isPrivateFile ? imageKit.url({ src: file.url, signed: true, expireSeconds: 300 }) : file.url;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Backup download failed: ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), meta: toStored(file) };
};

/**
 * Deletes backups beyond the newest `keep`. The newest pre-restore copy is
 * always kept. If the backup just made has far fewer documents than the one
 * before it (data may have been lost), nothing is pruned so older good copies
 * survive; the caller is told why.
 */
export const pruneBackups = async (latest) => {
  const all = await listBackups();
  const previous = all.find((b) => b.id !== latest?.id && b.reason !== "pre-restore");
  if (latest && previous?.docs && previous.docs >= 20 && (latest.docs ?? 0) < previous.docs * 0.5) {
    return {
      deleted: 0,
      warning: `This backup has ${latest.docs} documents, far fewer than the previous one (${previous.docs}). Older backups were kept in case data was lost.`,
    };
  }
  const newestPreRestore = all.find((b) => b.reason === "pre-restore");
  const extra = all.slice(keepCount()).filter((b) => b.id !== newestPreRestore?.id);
  let deleted = 0;
  for (const b of extra) {
    try {
      await imageKit.deleteFile(b.id);
      deleted++;
    } catch (err) {
      console.error("Couldn't delete old backup:", b.id, err?.message);
    }
  }
  return { deleted, warning: null };
};

/**
 * Takes a full backup and stores it encrypted in the cloud.
 * @param {import("mongodb").Db} db
 * @param {{ reason: "manual"|"scheduled"|"pre-restore", createdBy?: string }} info
 * @param {Record<string, any[]>} [collections] an already-taken snapshot
 */
export const createCloudBackup = async (db, info, collections) => {
  if (!encryptionConfigured()) {
    throw new BackupError("Cloud backups are off: set BACKUP_SECRET (at least 16 characters) on the server.");
  }
  const { buffer, header } = await serialize(collections ?? (await snapshot(db)), { ...info, database: db.databaseName });
  const uploaded = await uploadEncrypted(buffer, header);
  /** @type {StoredBackup} */
  const stored = {
    id: uploaded.fileId,
    name: uploaded.name,
    createdAt: header.createdAt,
    size: uploaded.size ?? buffer.length,
    reason: info.reason,
    docs: header.totalDocs,
  };
  const { deleted, warning } = await pruneBackups(stored).catch((err) => {
    console.error("Backup pruning failed:", err?.message);
    return { deleted: 0, warning: null };
  });
  return { backup: stored, header, pruned: deleted, warning };
};
