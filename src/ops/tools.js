import mongoose from "mongoose";
import { AdSnapshot, OpsAction, getConfig } from "./models.js";
import { monthSpendUsd } from "./claude.js";
import { notice } from "./actions.js";
import razorpay from "../config/razorpay.js";

/*
 * Third-party services found in the code (scan of 25 Nov 2026). Usage is
 * read automatically where the service exposes it cheaply; the rest are
 * entered by hand in Ops → Tools. Each reading is kept for 90 days so the
 * tab can project when a limit will be hit at the current growth rate.
 */

export const TOOLS = [
  { id: "vercel", name: "Vercel", purpose: "Hosts the website and backend, daily backup cron", metric: "Plan & bandwidth", unit: "GB", source: "manual", hint: "The free Hobby plan is for non-commercial use; a business site belongs on Pro." },
  { id: "mongodb", name: "MongoDB Atlas", purpose: "Database", metric: "Storage used", unit: "MB", source: "auto", defaultLimit: 512, hint: "Free M0 cluster: 512 MB, shared. Upgrade at ~80%." },
  { id: "upstash-redis", name: "Upstash Redis", purpose: "Rate limits and caching", metric: "Commands per day", unit: "commands", source: "manual" },
  { id: "qstash", name: "Upstash QStash", purpose: "Payment fulfilment queue, delayed jobs, the ops tick", metric: "Messages per day", unit: "messages", source: "manual", hint: "The ops tick adds ~96 messages a day (every 15 min)." },
  { id: "imagekit", name: "ImageKit", purpose: "Member photos and post images", metric: "Bandwidth this month", unit: "GB", source: "auto", defaultLimit: 20 },
  { id: "msg91", name: "MSG91", purpose: "WhatsApp OTP and all transactional email", metric: "WhatsApp prepaid balance", unit: "₹", source: "auto", lowIsBad: true, defaultLimit: 500, hint: "Prepaid: OTPs stop when it is empty. Read daily; an urgent alert below the limit (default ₹500)." },
  { id: "razorpay", name: "Razorpay", purpose: "Payments", metric: "Fees this month", unit: "₹", source: "auto", hint: "Razorpay's fee incl. GST on this month's captured payments (IST), read daily." },
  { id: "openai", name: "OpenAI (gpt-4.1)", purpose: "Astrology insights", metric: "Spend this month", unit: "$", source: "manual" },
  { id: "claude", name: "Claude API", purpose: "This Ops agent", metric: "Spend this month", unit: "$", source: "auto" },
  { id: "freeastro", name: "FreeAstrologyAPI", purpose: "Astrology charts", metric: "Calls this month", unit: "calls", source: "manual" },
  { id: "timezonedb", name: "TimezoneDB", purpose: "Time zones for astrology", metric: "Calls per second limit", unit: "calls", source: "manual" },
  { id: "nominatim", name: "OpenStreetMap Nominatim", purpose: "Birthplace lookup (backend)", metric: "Fair use ~1 request/second", unit: "", source: "manual", hint: "Free public service with no guarantee; needs a fallback as traffic grows." },
  { id: "photon", name: "Photon (Komoot)", purpose: "Place search on the site", metric: "Fair use", unit: "", source: "manual", hint: "Free public service; same risk as Nominatim." },
  { id: "meta", name: "Meta ads", purpose: "Ads, Pixel, Page, Instagram", metric: "Prepaid funds", unit: "₹", source: "auto", lowIsBad: true },
  { id: "domain", name: "Domain (seetharamakalyana.in)", purpose: "Website and email domain", metric: "Renewal date", unit: "", source: "manual" },
  { id: "godaddy-mail", name: "GoDaddy email", purpose: "contactus@ mailbox", metric: "Mailbox storage", unit: "GB", source: "manual" },
];

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const imagekitUsage = async () => {
  const end = today();
  const start = `${end.slice(0, 8)}01`;
  const auth = Buffer.from(`${process.env.IMAGEKIT_PRIVATE_KEY}:`).toString("base64");
  const res = await fetch(`https://api.imagekit.io/v1/accounts/usage?startDate=${start}&endDate=${end}`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ImageKit ${res.status}`);
  const u = await res.json();
  return { value: (u.bandwidthBytes ?? 0) / 1e9, extra: { storageGB: (u.mediaLibraryStorageBytes ?? 0) / 1e9 } };
};

/** Razorpay's fees (incl. GST) on payments captured this month (IST), in ₹. */
export const razorpayMonth = async (now = Date.now()) => {
  const ist = new Date(now + 5.5 * 3600000);
  const from = Math.floor((Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600000) / 1000);
  const to = Math.floor(now / 1000);
  let fees = 0;
  let gross = 0;
  let count = 0;
  for (let skip = 0; skip < 5000; skip += 100) {
    const page = await razorpay.payments.all({ from, to, count: 100, skip });
    const items = page?.items ?? [];
    for (const p of items.filter((x) => x.status === "captured")) {
      fees += Number(p.fee) || 0;
      gross += Number(p.amount) || 0;
      count++;
    }
    if (items.length < 100) break;
  }
  return { value: fees / 100, extra: { captured: gross / 100, payments: count } };
};

/** MSG91's WhatsApp prepaid balance in ₹ (POST /subscriptions/fetchPrepaidBalance). */
export const msg91Balance = async () => {
  if (!process.env.MSG91_AUTHKEY || !process.env.MSG91_WHATSAPP_SENDER_ID) throw new Error("MSG91 key or WhatsApp number not set");
  const res = await fetch("https://control.msg91.com/api/v5/subscriptions/fetchPrepaidBalance", {
    method: "POST",
    headers: { Authkey: process.env.MSG91_AUTHKEY, "Content-Type": "application/json" },
    body: JSON.stringify({ integrated_number: String(process.env.MSG91_WHATSAPP_SENDER_ID).replace(/\D/g, ""), service: "whatsapp" }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  const balance = Number(body?.prepaid_balance ?? body?.data?.prepaid_balance);
  if (!res.ok || !Number.isFinite(balance)) throw new Error(`MSG91 ${res.status}: ${String(body?.message ?? body?.status ?? "no balance in the reply").slice(0, 120)}`);
  return { value: balance, extra: { planStatus: body.plan_status ?? null } };
};

const readers = {
  mongodb: async () => {
    const s = await mongoose.connection.db.stats();
    return { value: (s.storageSize + (s.indexSize ?? 0)) / 1e6, extra: { dataMB: s.dataSize / 1e6, objects: s.objects } };
  },
  imagekit: imagekitUsage,
  razorpay: () => razorpayMonth(),
  msg91: () => msg91Balance(),
  claude: async () => ({ value: await monthSpendUsd() }),
  meta: async () => {
    const row = await AdSnapshot.findOne({ level: "account", funds: { $ne: null } }).sort({ date: -1 }).lean();
    return row ? { value: row.funds } : null;
  },
};

/** Takes today's automatic readings (once a day). */
export const readTools = async () => {
  const config = await getConfig();
  const tools = { ...(config.tools ?? {}) };
  for (const [id, read] of Object.entries(readers)) {
    try {
      const r = await read();
      if (!r) continue;
      const entry = tools[id] ?? {};
      const history = (entry.history ?? []).filter((h) => h.date !== today()).slice(-89);
      history.push({ date: today(), value: Math.round(r.value * 100) / 100 });
      tools[id] = { ...entry, current: history.at(-1).value, extra: r.extra, history, readAt: new Date(), error: null };
    } catch (err) {
      tools[id] = { ...(tools[id] ?? {}), error: String(err.message).slice(0, 200) };
    }
  }
  config.tools = tools;
  config.markModified("tools");
  await config.save();

  // OTPs (and so sign-ups) stop when the MSG91 wallet is empty: say so before it is.
  const m = tools.msg91;
  const floor = m?.limit ?? 500;
  if (m?.current != null && m.readAt && Date.now() - new Date(m.readAt).getTime() < 3600000 && m.current < floor) {
    await notice("tools", {
      type: "tools.msg91_low",
      priority: "urgent",
      title: `MSG91 balance is low: ₹${Math.round(m.current)}`,
      reason: `Below your ₹${floor} alert level. WhatsApp OTPs stop when it runs out, and families can't sign up.`,
      effect: "Top up the MSG91 wallet (msg91.com → Wallet). Alert only.",
      payload: { dedupeKey: `msg91_low:${today()}` },
    }).catch(() => {});
  } else if (m?.current != null && m.current >= floor) {
    // Topped up: earlier low-balance alerts are marked resolved and leave Today.
    await OpsAction.updateMany(
      { type: "tools.msg91_low", status: "info", "payload.resolvedAt": null },
      { $set: { "payload.resolvedAt": new Date() } }
    ).catch(() => {});
  }
};

/** Growth per day over the stored history (least squares), or null. */
const slope = (history) => {
  if (!history || history.length < 5) return null;
  const pts = history.map((h) => ({ x: Date.parse(h.date) / 86400000, y: h.value }));
  const mx = pts.reduce((t, p) => t + p.x, 0) / pts.length;
  const my = pts.reduce((t, p) => t + p.y, 0) / pts.length;
  const num = pts.reduce((t, p) => t + (p.x - mx) * (p.y - my), 0);
  const den = pts.reduce((t, p) => t + (p.x - mx) ** 2, 0);
  return den ? num / den : null;
};

/** The Tools screen: each tool with usage, limit and the projected date it is reached. */
export const toolsOverview = async () => {
  const config = await getConfig();
  return TOOLS.map((t) => {
    const s = config.tools?.[t.id] ?? {};
    const limit = s.limit ?? t.defaultLimit ?? (t.id === "claude" ? config.limits.claudeMonthlyUsd : null);
    const current = s.current ?? null;
    const perDay = slope(s.history);
    let hitsLimitOn = null;
    if (limit && current != null && perDay && !t.lowIsBad && perDay > 0 && current < limit) {
      hitsLimitOn = new Date(Date.now() + ((limit - current) / perDay) * 86400000).toISOString().slice(0, 10);
    }
    const pct = limit && current != null ? Math.round((current / limit) * 100) : null;
    const status =
      s.error ? "error" : t.lowIsBad ? (limit && current != null && current < limit ? "upgrade" : "ok") : pct == null ? "unknown" : pct >= 80 ? "upgrade" : pct >= 60 ? "watch" : "ok";
    return {
      ...t,
      plan: s.plan ?? "",
      notes: s.notes ?? "",
      renewsOn: s.renewsOn ?? null,
      limit,
      current,
      pct,
      perDay,
      hitsLimitOn,
      status,
      error: s.error ?? null,
      readAt: s.readAt ?? null,
      history: (s.history ?? []).slice(-30),
    };
  });
};

/** Saves hand-entered details for one tool. */
export const updateTool = async (id, fields) => {
  if (!TOOLS.some((t) => t.id === id)) throw new Error("Unknown tool");
  const config = await getConfig();
  const entry = { ...(config.tools?.[id] ?? {}) };
  for (const k of ["plan", "notes", "renewsOn"]) if (fields[k] !== undefined) entry[k] = String(fields[k]).slice(0, 300);
  if (fields.limit !== undefined) entry.limit = fields.limit === "" || fields.limit == null ? null : Number(fields.limit);
  if (fields.current !== undefined && fields.current !== "") {
    const history = (entry.history ?? []).filter((h) => h.date !== today()).slice(-89);
    history.push({ date: today(), value: Number(fields.current) });
    entry.history = history;
    entry.current = Number(fields.current);
  }
  config.tools = { ...(config.tools ?? {}), [id]: entry };
  config.markModified("tools");
  await config.save();
};
