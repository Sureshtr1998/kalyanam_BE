#!/usr/bin/env node
/*
 * Database backups from the command line — for when the website itself is
 * down, or the database has to be rebuilt somewhere new.
 *
 * Reads MONGO_URI (and BACKUP_SECRET + IMAGEKIT_* for cloud copies) from .env.
 * To restore into a different cluster, set MONGO_URI for that one command:
 *   MONGO_URI="mongodb+srv://.../kalyanam" node scripts/db-backup.js restore file.json.gz
 *
 *   node scripts/db-backup.js list                        cloud backups, newest first
 *   node scripts/db-backup.js backup [out.json.gz]        save the database to a local file
 *   node scripts/db-backup.js download <id> [out.json.gz] save a cloud backup to a local file
 *   node scripts/db-backup.js verify <file|id>            check a backup without touching the database
 *   node scripts/db-backup.js restore <file|id> [--only users,brokers] [--apply]
 *
 * `restore` is a dry run unless --apply is given. With --apply it shows the
 * target database, asks you to type its name, saves the current data to a
 * local pre-restore file, and only then writes.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import readline from "node:readline/promises";
import mongoose from "mongoose";
import { liveCounts, parseBackup, restoreCollections, serialize, snapshot, stamp, toPlainGzip } from "../src/utils/backup.js";

const [cmd, arg, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name) || arg === name;
const option = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

const connect = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.db;
};

const target = () => {
  const uri = new URL(String(process.env.MONGO_URI).replace(/^mongodb(\+srv)?:/, "http:"));
  return `${uri.hostname}${uri.pathname}`;
};

const store = () => import("../src/utils/backupStore.js");

/** A local file path, or else a cloud backup id. */
const readBackup = async (ref) => {
  if (!ref) throw new Error("Give a backup file path or cloud backup id.");
  try {
    return await fs.readFile(ref);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const { fetchBackupFile } = await store();
    return (await fetchBackupFile(ref)).buffer;
  }
};

const table = (rows) => console.table(rows);

const commands = {
  async list() {
    const { listBackups } = await store();
    const all = await listBackups();
    if (!all.length) return console.log("No cloud backups yet.");
    table(all.map((b) => ({ id: b.id, created: b.createdAt, reason: b.reason, docs: b.docs, kb: Math.round(b.size / 1024) })));
  },

  async backup() {
    const db = await connect();
    const { buffer, header } = await serialize(await snapshot(db), { reason: "cli", database: db.databaseName });
    const out = arg || `kalyanam-backup_${stamp(header.createdAt)}.json.gz`;
    await fs.writeFile(out, buffer);
    console.log(`Saved ${header.totalDocs} documents from ${target()} to ${out}`);
  },

  async download() {
    const { fetchBackupFile } = await store();
    const { buffer, meta } = await fetchBackupFile(arg);
    const plain = toPlainGzip(buffer);
    const { header } = await parseBackup(plain);
    const out = rest[0] || `kalyanam-backup_${stamp(meta.createdAt)}.json.gz`;
    await fs.writeFile(out, plain);
    console.log(`Saved ${header.totalDocs} documents (verified) to ${out}`);
  },

  async verify() {
    const { header } = await parseBackup(await readBackup(arg));
    console.log(`OK: taken ${header.createdAt} (${header.reason}) from "${header.database}", checksum verified.`);
    table(header.counts);
  },

  async restore() {
    const { header, collections } = await parseBackup(await readBackup(arg));
    const only = option("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
    const names = only ?? Object.keys(collections);
    const unknown = names.filter((n) => !(n in collections));
    if (unknown.length) throw new Error(`Not in this backup: ${unknown.join(", ")}`);

    const db = await connect();
    const current = await liveCounts(db);
    console.log(`Backup taken ${header.createdAt} from "${header.database}" (checksum verified).`);
    console.log(`Target: ${target()}\n`);
    table(Object.fromEntries(names.map((n) => [n, { now: current[n] ?? 0, afterRestore: collections[n].length }])));

    if (!flag("--apply")) {
      console.log("\nDry run: nothing was changed. Add --apply to restore.");
      return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(`\nThis REPLACES the collections above in "${db.databaseName}". Type the database name to continue: `);
    rl.close();
    if (typed.trim() !== db.databaseName) {
      console.log("Name didn't match. Nothing was changed.");
      return;
    }

    const before = await snapshot(db);
    const safety = await serialize(before, { reason: "pre-restore", database: db.databaseName });
    const safetyFile = `kalyanam-pre-restore_${stamp(safety.header.createdAt)}.json.gz`;
    await fs.writeFile(safetyFile, safety.buffer);
    console.log(`Safety copy of the current data saved to ${safetyFile}`);

    try {
      table(await restoreCollections(db, collections, names));
      console.log("Restore complete.");
    } catch (err) {
      console.error("Restore failed part-way, putting the old data back:", err.message);
      await restoreCollections(db, before, names.filter((n) => n in before));
      console.error(`Old data put back. (The safety copy is still in ${safetyFile}.)`);
      process.exitCode = 1;
    }
  },
};

try {
  if (!commands[cmd]) {
    console.log("Usage: node scripts/db-backup.js list | backup [out] | download <id> [out] | verify <file|id> | restore <file|id> [--only a,b] [--apply]");
    process.exitCode = 1;
  } else {
    await commands[cmd]();
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
