import { Router } from "express";
import { adminOnly, staffAuth } from "../../middleware/auth.js";
import upStash from "../../config/upStash.js";
import User from "../../models/User.js";
import Broker from "../../models/Broker.js";
import dbConnect from "../../utils/dbConnect.js";

/*
 * Meta (Facebook/Instagram) ad spend for the admin Overview.
 * Reads the Marketing API insights of META_AD_ACCOUNT_ID with a read-only
 * system-user token (META_ADS_TOKEN, `ads_read`). The token never leaves the
 * server. Results are cached in Redis for a few minutes so opening the admin
 * panel doesn't hit Meta every time.
 */

const router = Router();
router.use("/manage/ad-spend", staffAuth, adminOnly);

const GRAPH = "https://graph.facebook.com/v21.0";
const DAYS = 14;
const CACHE_KEY = "meta:ad-spend:v1";
const CACHE_SECONDS = 15 * 60;

// Pixel events the campaigns optimise for (see the register flow).
const LEAD_ACTIONS = ["offsite_conversion.fb_pixel_lead", "lead"];
const REG_ACTIONS = ["offsite_conversion.fb_pixel_complete_registration", "complete_registration"];

const accountId = () => {
  const raw = String(process.env.META_AD_ACCOUNT_ID || "").trim();
  return raw ? (raw.startsWith("act_") ? raw : `act_${raw}`) : "";
};

/** "YYYY-MM-DD" in the given IANA zone, `back` days ago. */
const dayIn = (tz, back = 0) =>
  new Date(Date.now() - back * 86400000).toLocaleDateString("en-CA", { timeZone: tz });

/** First matching action count (Meta reports the same event under several names). */
const actionCount = (actions, types) => {
  for (const type of types) {
    const hit = actions?.find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
};

const graphGet = async (path, params) => {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.META_ADS_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw Object.assign(new Error(body.error?.message || `Meta API ${res.status}`), { meta: body.error });
  }
  return body;
};

const fetchAdSpend = async () => {
  const act = accountId();
  const account = await graphGet(act, { fields: "name,currency,timezone_name,account_status" });
  const tz = account.timezone_name || "Asia/Kolkata";
  const since = dayIn(tz, DAYS - 1);
  const today = dayIn(tz);

  const insights = await graphGet(`${act}/insights`, {
    level: "account",
    fields: "spend,impressions,reach,clicks,inline_link_clicks,actions",
    time_range: { since, until: today },
    time_increment: 1,
    limit: 100,
  });

  const byDay = new Map(
    (insights.data ?? []).map((row) => [
      row.date_start,
      {
        date: row.date_start,
        spend: Number(row.spend) || 0,
        impressions: Number(row.impressions) || 0,
        reach: Number(row.reach) || 0,
        clicks: Number(row.inline_link_clicks ?? row.clicks) || 0,
        leads: actionCount(row.actions, LEAD_ACTIONS),
        registrations: actionCount(row.actions, REG_ACTIONS),
      },
    ])
  );
  // Meta leaves out days with no delivery; fill them so the chart has every day.
  const days = Array.from({ length: DAYS }, (_, i) => {
    const date = dayIn(tz, DAYS - 1 - i);
    return byDay.get(date) ?? { date, spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, registrations: 0 };
  });

  return {
    configured: true,
    account: { id: act, name: account.name, currency: account.currency, timezone: tz, status: account.account_status },
    days,
    fetchedAt: new Date().toISOString(),
  };
};

/**
 * Members who joined on each day (in the ad account's time zone), split into
 * partner referrals and everyone else. There's no ad attribution on members,
 * so "direct" sign-ups are the ones ads can take credit for (blended).
 */
const joinsByDay = async (days, tz) => {
  await dbConnect();
  const rows = await User.aggregate([
    { $match: { createdAt: { $gte: new Date(Date.now() - (days.length + 1) * 86400000) } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } },
        joined: { $sum: 1 },
        referred: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$basic.referralId", ""] } }, 0] }, 1, 0] } },
      },
    },
  ]);
  const map = new Map(rows.map((r) => [r._id, r]));
  return days.map((d) => {
    const r = map.get(d.date);
    const joined = r?.joined ?? 0;
    const referred = r?.referred ?? 0;
    return { ...d, joined, direct: joined - referred };
  });
};

/** Money left after refunds on one payment (same rule as the Overview's revenue). */
const NET_PAID = {
  $subtract: [
    { $ifNull: ["$transactions.amountPaid", 0] },
    { $add: [{ $ifNull: ["$transactions.amountRefunded", 0] }, { $ifNull: ["$transactions.referralRefunded", 0] }] },
  ],
};

/**
 * Money earned on each day (member payments + partner fees, net of refunds),
 * so the Overview can show spend vs earnings per day.
 */
const earningsByDay = async (days, tz) => {
  await dbConnect();
  const since = new Date(Date.now() - (days.length + 1) * 86400000);
  const pipeline = [
    { $unwind: "$transactions" },
    { $match: { "transactions.dateOfTrans": { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$transactions.dateOfTrans", timezone: tz } },
        earned: { $sum: NET_PAID },
      },
    },
  ];
  const [members, partners] = await Promise.all([User.aggregate(pipeline), Broker.aggregate(pipeline)]);
  const map = new Map();
  for (const r of [...members, ...partners]) map.set(r._id, (map.get(r._id) ?? 0) + r.earned);
  return days.map((d) => ({ ...d, earned: map.get(d.date) ?? 0 }));
};

const withJoins = async (data) => {
  try {
    const tz = data.account.timezone;
    return { ...data, days: await earningsByDay(await joinsByDay(data.days, tz), tz) };
  } catch (err) {
    console.error("Ad spend joins error:", err);
    return data;
  }
};

router.get("/manage/ad-spend", async (req, res) => {
  if (!process.env.META_ADS_TOKEN || !accountId()) {
    return res.json({ configured: false });
  }
  const fresh = req.query.refresh === "1";
  try {
    if (!fresh) {
      const cached = await upStash.get(CACHE_KEY).catch(() => null);
      if (cached) return res.json({ ...(await withJoins(cached)), cached: true });
    }
    const data = await fetchAdSpend();
    await upStash.set(CACHE_KEY, data, { ex: CACHE_SECONDS }).catch(() => {});
    return res.json(await withJoins(data));
  } catch (err) {
    console.error("Meta ad spend error:", err.message, err.meta ?? "");
    // Meta reuses code 200 for several things, so read the message too.
    const code = err.meta?.code;
    const metaMsg = String(err.meta?.message || "");
    const msg =
      code === 190
        ? "The Meta token has expired or is invalid. Generate a new one."
        : /api access blocked/i.test(metaMsg)
        ? "Meta has blocked API access for the app (often a developer account check). Open developers.facebook.com and complete any confirmation it asks for."
        : /ads_read|ads_management|permission/i.test(metaMsg) || code === 10
        ? "The Meta token doesn't have ads_read access to this ad account."
        : code === 4 || code === 17 || code === 80000 || code === 80004
        ? "Meta's rate limit was hit. Try again in a few minutes."
        : err.meta
        ? `Meta said: ${metaMsg || "unknown error"}`
        : "Couldn't reach Meta right now.";
    return res.status(502).json({ msg });
  }
});

export default router;
