/*
 * Gives every existing member a refer & earn code. Run once from kalyanam_BE
 * after deploying refer & earn, against the database in MONGO_URI:
 *
 *   node scripts/backfill-referral-codes.js --dry-run   # count only, writes nothing
 *   node scripts/backfill-referral-codes.js
 *
 * Safe to re-run: members who already have a code are left alone. Not strictly
 * required either: a member without a code gets one the first time they open
 * the Refer & earn tab. Running it means every code exists up front.
 */
import "dotenv/config";
import mongoose from "mongoose";
import User from "../src/models/User.js";
import { ensureReferralCode } from "../src/utils/referrals.js";

const dryRun = process.argv.includes("--dry-run");
const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("MONGO_URI is not set.");
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
const missing = { referralCode: { $exists: false } };
const total = await User.countDocuments(missing);
console.log(
  `${total} member(s) without a referral code${dryRun ? " (dry run, nothing written)" : ""}.`,
);

let done = 0;
let failed = 0;
if (!dryRun) {
  // The unique index on referralCode must exist before codes are written.
  await User.createIndexes();
  for await (const user of User.find(missing)
    .select("_id basic.fullName referralCode")
    .cursor()) {
    try {
      await ensureReferralCode(user);
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${total}`);
    } catch (err) {
      failed++;
      console.error(`  ${user._id}: ${err.message}`);
    }
  }
  console.log(`Done: ${done} code(s) added, ${failed} failed.`);
}

await mongoose.disconnect();
process.exit(failed ? 1 : 0);
