import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import mongoose from "mongoose";

/*
 * Whole-database backups.
 *
 * A backup file is gzip of two lines:
 *   1. a JSON header: format, version, when, why, by whom, per-collection counts
 *      and the SHA-256 of line 2
 *   2. every collection as canonical Extended JSON (keeps ObjectIds, Dates,
 *      Decimals etc. exactly, so a restore puts back identical documents)
 *
 * Copies kept in the cloud are additionally encrypted with AES-256-GCM using a
 * key derived from BACKUP_SECRET, so a leaked file is useless without it.
 * Downloads to the admin's computer are the plain .json.gz (readable, and can
 * be restored through the app or scripts/db-backup.js).
 */

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const { EJSON } = mongoose.mongo.BSON;

export const FORMAT = "kalyanam-db-backup";
export const VERSION = 1;
const MAGIC = Buffer.from("KBAK1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INSERT_CHUNK = 500;

/** Collections in the live database worth backing up (not MongoDB's own). */
export const listCollectionNames = async (db) => {
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  return infos
    .filter((c) => (c.type ?? "collection") === "collection" && !c.name.startsWith("system."))
    .map((c) => c.name)
    .sort();
};

/** Document counts per collection in the live database. */
export const liveCounts = async (db) => {
  const names = await listCollectionNames(db);
  const counts = {};
  for (const name of names) counts[name] = await db.collection(name).countDocuments();
  return counts;
};

/** Reads every document of every collection into memory. */
/** @returns {Promise<Record<string, any[]>>} */
export const snapshot = async (db) => {
  /** @type {Record<string, any[]>} */
  const collections = {};
  for (const name of await listCollectionNames(db)) {
    collections[name] = await db.collection(name).find({}).toArray();
  }
  return collections;
};

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/**
 * @param {Record<string, any[]>} collections
 * @param {{ reason: string, createdBy?: string, database?: string }} info
 * @returns {Promise<{ buffer: Buffer, header: BackupHeader }>}
 */
export const serialize = async (collections, info) => {
  const data = EJSON.stringify(collections, { relaxed: false });
  const counts = Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
  /** @type {BackupHeader} */
  const header = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    reason: info.reason,
    createdBy: info.createdBy ?? null,
    database: info.database ?? null,
    counts,
    totalDocs: Object.values(counts).reduce((a, b) => a + b, 0),
    checksum: sha256(data),
  };
  const buffer = await gzip(Buffer.from(`${JSON.stringify(header)}\n${data}`, "utf8"), { level: 9 });
  return { buffer, header };
};

/**
 * @typedef {object} BackupHeader
 * @property {string} format
 * @property {number} version
 * @property {string} createdAt
 * @property {string} reason
 * @property {string|null} createdBy
 * @property {string|null} database
 * @property {Record<string, number>} counts
 * @property {number} totalDocs
 * @property {string} checksum
 */

const keyFromSecret = (secret) => crypto.scryptSync(String(secret), "kalyanam-db-backup-v1", 32);

export const encryptionConfigured = () => String(process.env.BACKUP_SECRET || "").length >= 16;

export const encrypt = (buffer, secret = process.env.BACKUP_SECRET) => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
};

export const decrypt = (buffer, secret = process.env.BACKUP_SECRET) => {
  if (!secret) throw new BackupError("This backup is encrypted and BACKUP_SECRET is not set.");
  const iv = buffer.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buffer.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const body = buffer.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new BackupError("Couldn't decrypt this backup: BACKUP_SECRET is different from when it was made, or the file is damaged.");
  }
};

export class BackupError extends Error {
  /** HTTP status to answer with (default 400). @type {number | undefined} */
  status;
}

export const isEncrypted = (buffer) => buffer.subarray(0, MAGIC.length).equals(MAGIC);

/** Turns an encrypted .kbak or a plain .json.gz into the plain .json.gz. */
export const toPlainGzip = (buffer) => (isEncrypted(buffer) ? decrypt(buffer) : buffer);

/**
 * Opens a backup file (encrypted, gzipped or plain text) and checks it fully:
 * format, version, checksum, and that every collection has the number of
 * documents the header promises, each with an _id. Throws BackupError.
 * @returns {Promise<{ header: BackupHeader, collections: Record<string, any[]> }>}
 */
export const parseBackup = async (buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new BackupError("The backup file is empty.");
  let raw = toPlainGzip(buffer);
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      raw = await gunzip(raw);
    } catch {
      throw new BackupError("The backup file is damaged (couldn't unzip it).");
    }
  }
  const text = raw.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline < 0) throw new BackupError("This isn't a Kalyanam backup file.");

  let header;
  try {
    header = JSON.parse(text.slice(0, newline));
  } catch {
    throw new BackupError("This isn't a Kalyanam backup file.");
  }
  if (header?.format !== FORMAT) throw new BackupError("This isn't a Kalyanam backup file.");
  if (header.version > VERSION) throw new BackupError(`This backup was made by a newer version (v${header.version}). Update the server first.`);

  const data = text.slice(newline + 1);
  if (sha256(data) !== header.checksum) {
    throw new BackupError("The backup failed its integrity check (checksum mismatch). It may be damaged or edited.");
  }
  let collections;
  try {
    collections = EJSON.parse(data, { relaxed: false });
  } catch {
    throw new BackupError("The backup's data couldn't be read.");
  }
  if (!collections || typeof collections !== "object" || Array.isArray(collections)) {
    throw new BackupError("The backup's data is not in the expected shape.");
  }
  for (const [name, docs] of Object.entries(collections)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith("system.")) {
      throw new BackupError(`The backup contains an unexpected collection name: ${name}`);
    }
    if (!Array.isArray(docs) || docs.length !== header.counts?.[name]) {
      throw new BackupError(`Collection "${name}" doesn't have the number of documents the backup says it should.`);
    }
    if (docs.some((d) => !d || typeof d !== "object" || d._id === undefined)) {
      throw new BackupError(`Collection "${name}" has documents without an _id.`);
    }
  }
  return { header, collections };
};

/**
 * Replaces the chosen collections with the backup's documents. Collections
 * not chosen are left alone. Indexes are kept (deleteMany, not drop).
 * @returns {Promise<Record<string, { deleted: number, inserted: number }>>}
 */
export const restoreCollections = async (db, collections, names) => {
  /** @type {Record<string, { deleted: number, inserted: number }>} */
  const result = {};
  for (const name of names) {
    const docs = collections[name] ?? [];
    const coll = db.collection(name);
    const { deletedCount } = await coll.deleteMany({});
    let inserted = 0;
    for (let i = 0; i < docs.length; i += INSERT_CHUNK) {
      const res = await coll.insertMany(docs.slice(i, i + INSERT_CHUNK), { ordered: true });
      inserted += res.insertedCount;
    }
    result[name] = { deleted: deletedCount, inserted };
  }
  return result;
};

/** "2026-11-08T21-30-00Z" — safe in file names. */
export const stamp = (iso = new Date().toISOString()) => iso.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
