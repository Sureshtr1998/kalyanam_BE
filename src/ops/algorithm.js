import { AdSnapshot, OpsAction, OpsConfig, OpsCreative, getConfig } from "./models.js";
import { DEFAULT_RULES, TUNABLE, tuneValue } from "./adsEngine.js";
import { adsSettings, unitStates } from "./ads.js";
import { ask } from "./claude.js";
import { handle, handleUndo, notice, propose, undo } from "./actions.js";

/*
 * The monthly algorithm review (owner's request, 28 Nov 2026). Every 30 days
 * (or 14, in Ops → Algorithm) the agent looks at what its ad decisions did,
 * and may propose up to 3 changes to the engine's numbers (adsEngine.TUNABLE),
 * always inside hard bounds. The owner gets a WhatsApp; the update applies by
 * itself after 2 days unless cancelled. 14 days later the agent checks the
 * cost per real member and undoes its own update if it got 15%+ worse.
 * The owner's own rules are never tuned.
 */

const DAY = 86400000;
const HOUR = 3600000;
export const NOTICE_HOURS = 48;
export const MAX_CHANGES = 3;
/** Undone by itself if the cost per real member got this much worse in the 14 days after. */
export const WORSE_RATIO = 1.15;

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

/** The owner's own rules (what they said, and what they set in Settings), with today's figures. Never tuned. */
export const ownerRules = (config) => {
  const ads = adsSettings(config);
  const ramp = ads.rampUp ?? {};
  const until = ramp.until ? ` until ${new Date(ramp.until).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}` : "";
  return [
    "Ads run in Kannada, Telugu, Tamil and Hindi at all times.",
    (ramp.languages ?? []).length
      ? `${ramp.languages.join(", ")} are ramp-up languages${until}: never cut or moved away for costing more than the others.`
      : "No ramp-up languages are set.",
    "Prepaid funds never decide anything (Meta tops itself up).",
    "The agent never refunds money.",
    "Organic posts are never boosted or turned into ads.",
    "One campaign per language, with Parents and Young as its ad sets; no NRI, outside-state or new-language ad sets unless you ask.",
    "The Women safety campaign stays paused.",
    "Campaigns that work don't get changes that restart Meta's learning.",
    `Daily budget ceiling: ${inr(config.limits?.maxDailySpend)} (Settings → Limits)${ads.autoCeiling !== false ? ". It raises itself by 25% when budgets reach 90% of it and the account earns its target return; you get a WhatsApp." : "."}`,
    `Losing line: ${inr(config.limits?.losingCostPerMember)} per real member (Settings → Limits).`,
  ];
};

/** Safety defaults the agent added; not tuned by the review either. */
export const SAFETY_DEFAULTS = [
  "Every language keeps at least ₹500 a day and 2 running ads.",
  "24 hours' notice before every change, with Cancel and Undo (new ads are checked with Meta in that time).",
  "Budget steps stay under 20%, and the total grows at most +25% a week, so Meta's learning isn't reset.",
  "Billing and payment settings are never touched.",
];

const istDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const rs = (n) => (n == null || !Number.isFinite(n) ? "–" : `₹${Math.round(n).toLocaleString("en-IN")}`);

/** The first Monday at 11:30 am IST at or after `ms`. */
export const mondayOnOrAfter = (ms) => {
  const ist = new Date(ms + 5.5 * HOUR);
  const add = (1 - ist.getUTCDay() + 7) % 7;
  let at = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, 11, 30) - 5.5 * HOUR;
  if (at < ms) at += 7 * DAY;
  return new Date(at);
};

/** A tunable number's current value. */
export const valueOf = (config, key) => {
  const s = TUNABLE[key];
  if (s.where === "rules") return config.algorithm?.tuning?.[key] ?? DEFAULT_RULES[key];
  if (s.where === "limits") return config.limits?.[key] ?? s.def;
  return adsSettings(config)[key] ?? s.def;
};
const defaultOf = (key) => (TUNABLE[key].where === "rules" ? DEFAULT_RULES[key] : TUNABLE[key].def);
const fmt = (key, v) => {
  const u = TUNABLE[key].unit;
  if (u === "₹") return rs(v);
  if (u === "%") return `${v}%`;
  if (u === "x" || u === "×") return `${v}×`;
  return `${v}${u ? ` ${u}` : ""}`;
};

/** Spend, Meta members, real joins and the cost per real member between two times (account level). */
const accountWindow = async (from, to) => {
  const rows = await AdSnapshot.find({ level: "account", date: { $gte: istDay(from), $lt: istDay(to) } }).lean();
  const spend = rows.reduce((t, r) => t + (r.spend || 0), 0);
  const paid = rows.reduce((t, r) => t + (r.paid || 0), 0);
  const joined = rows.reduce((t, r) => t + (r.joined || 0), 0);
  return { days: rows.length, spend: Math.round(spend), paid, joined, realCpp: joined ? spend / joined : null, metaCpp: paid ? spend / paid : null };
};

/** Cost per Meta member of one campaign / ad set between two times. */
const entityCpp = async (entityId, from, to) => {
  const rows = await AdSnapshot.find({ entityId, level: { $in: ["campaign", "adset"] }, date: { $gte: istDay(from), $lt: istDay(to) } }).lean();
  const spend = rows.reduce((t, r) => t + (r.spend || 0), 0);
  const paid = rows.reduce((t, r) => t + (r.paid || 0), 0);
  return paid ? spend / paid : null;
};

/** What the agent's ad decisions did over the period: the evidence the review reads. */
export const algorithmEvidence = async (days, now = Date.now()) => {
  const [period, before] = await Promise.all([accountWindow(now - days * DAY, now), accountWindow(now - 2 * days * DAY, now - days * DAY)]);
  const decided = await OpsAction.find({
    module: "ads",
    type: { $in: ["ads.budget", "ads.rebalance", "ads.pause_ad", "ads.creative_launch", "ads.merge_test", "ads.algorithm_update"] },
    status: { $in: ["done", "cancelled"] },
    updatedAt: { $gte: new Date(now - days * DAY) },
  })
    .sort({ updatedAt: 1 })
    .limit(60)
    .lean();
  const lines = [];
  for (const a of decided) {
    const at = new Date(a.ranAt ?? a.updatedAt).getTime();
    const ids = [a.payload?.entityId, ...(a.payload?.moves ?? []).map((m) => m.entityId)].filter(Boolean);
    let outcome = "";
    if (a.status === "done" && ids.length && ["ads.budget", "ads.rebalance"].includes(a.type)) {
      const parts = [];
      for (const id of [...new Set(ids)]) {
        const [b, af] = await Promise.all([entityCpp(id, at - 7 * DAY, at), entityCpp(id, at, Math.min(now, at + 7 * DAY))]);
        parts.push(`${rs(b)} → ${rs(af)} per member (7 days before → after)`);
      }
      outcome = parts.join("; ");
    }
    const who = a.status === "cancelled" ? (a.decidedBy && a.decidedBy !== "agent" ? "CANCELLED BY THE OWNER" : "cancelled") : "done";
    lines.push(`${istDay(at)} ${a.type} [${who}] ${a.title}${outcome ? ` — ${outcome}` : ""}`);
  }
  const verdicts = await OpsCreative.aggregate([{ $match: { verdictAt: { $gte: new Date(now - days * DAY) } } }, { $group: { _id: "$verdict", n: { $sum: 1 } } }]);
  const states = await unitStates().catch(() => []);
  // Weekly cost per member per language, oldest first (5 weeks).
  const weeks = [];
  for (let w = 4; w >= 0; w--) weeks.push([now - (w + 1) * 7 * DAY, now - w * 7 * DAY]);
  const trend = [];
  for (const s of states) {
    const vals = [];
    for (const [f, t] of weeks) vals.push(rs(await entityCpp(s.id, f, t)));
    trend.push(`${s.name}: ${vals.join(" → ")}`);
  }
  return {
    period,
    before,
    text: [
      `Account, last ${days} days: spend ${rs(period.spend)}, ${period.joined} real joins (${period.paid} on Meta), ${rs(period.realCpp)} per real member. The ${days} days before: spend ${rs(before.spend)}, ${before.joined} real joins, ${rs(before.realCpp)} per real member.`,
      `Languages now: ${states.map((s) => `${s.name} — ${s.state}${s.flags?.tired ? " (tired)" : ""}. ${s.notes.join(" ")}`).join(" | ")}`,
      `Weekly cost per member (Meta), 5 weeks, oldest first: ${trend.join(" | ")}`,
      `New-ad verdicts in the period: ${verdicts.map((v) => `${v._id ?? "pending"} ${v.n}`).join(", ") || "none yet"}.`,
      `The agent's ad decisions in the period (${lines.length}):\n${lines.join("\n") || "none"}`,
    ].join("\n\n"),
  };
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "changes"],
  properties: {
    summary: { type: "string", description: "Plain English for the owner: what the numbers show and why the change (or why no change), with numbers" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "to", "reason", "expected"],
        properties: {
          key: { type: "string", enum: Object.keys(TUNABLE) },
          to: { type: "number" },
          reason: { type: "string", description: "The evidence for this change, with numbers" },
          expected: { type: "string", description: "What should improve, measurably, in the next 30 days" },
        },
      },
    },
  },
};

/** The model's proposals made safe: known keys, inside bounds, on step, at most half the range per move, at most 3. */
export const validateChanges = (config, proposed = []) => {
  const out = [];
  const seen = new Set();
  for (const c of proposed ?? []) {
    const s = TUNABLE[c?.key];
    if (!s || seen.has(c.key) || !Number.isFinite(Number(c.to))) continue;
    const from = valueOf(config, c.key);
    let to = tuneValue(c.key, c.to);
    const maxMove = (s.max - s.min) / 2;
    if (Math.abs(to - from) > maxMove) to = tuneValue(c.key, from + Math.sign(to - from) * maxMove);
    if (Math.abs(to - from) < s.step / 2) continue;
    seen.add(c.key);
    out.push({ key: c.key, label: s.label, unit: s.unit, from, to, reason: String(c.reason ?? "").slice(0, 500), expected: String(c.expected ?? "").slice(0, 300) });
    if (out.length >= MAX_CHANGES) break;
  }
  return out;
};

const changeLine = (c) => `• ${c.label}: ${fmt(c.key, c.from)} → ${fmt(c.key, c.to)}. ${c.reason}${c.expected ? ` Expected: ${c.expected}` : ""}`;

/**
 * The review: due every `everyDays` (checked each Monday 11:30 am IST, or
 * forced from Ops → Algorithm). Proposes an update card that applies by
 * itself after 2 days (WhatsApp to the owner), or notes "no change".
 */
export const runAlgorithmReview = async ({ force = false, now = Date.now() } = {}) => {
  const config = await getConfig();
  const alg = config.algorithm ?? {};
  const everyDays = alg.everyDays ?? 30;
  if (!force && alg.nextReviewAt && now < new Date(alg.nextReviewAt).getTime()) {
    return { skipped: `Next review on ${istDay(new Date(alg.nextReviewAt).getTime() + 5.5 * HOUR)}` };
  }
  if (await OpsAction.exists({ type: "ads.algorithm_update", status: { $in: ["scheduled", "shadow", "needs_you", "running"] } })) {
    return { skipped: "An algorithm update is already waiting" };
  }
  const evidence = await algorithmEvidence(everyDays, now);
  const current = Object.keys(TUNABLE)
    .map((k) => `${k} = ${valueOf(config, k)} (shipped ${defaultOf(k)}, allowed ${TUNABLE[k].min}–${TUNABLE[k].max}): ${TUNABLE[k].group} — ${TUNABLE[k].label}`)
    .join("\n");
  const out = await ask({
    task: "ads.algorithm",
    tier: "ads",
    system: `You review the rules of the Meta ads budget engine of Seetha Rama Kalyana, a Hindu matrimony site (one campaign per language: Kannada, Telugu, Tamil, Hindi; ₹351 a year per member; about ₹285 net per member).
You may change only the numbers listed, inside their allowed range, at most ${MAX_CHANGES}, and only when the evidence clearly supports it: cite the numbers. Prefer no change: every change makes Meta re-learn and makes results harder to read. Look for decisions that didn't work (cost per member worse after a move or raise), rules that never fired or fired too often, decisions the owner cancelled, and languages stuck in the same state.
Never propose anything about the owner's own rules or the safety defaults: ${[...ownerRules(config), ...SAFETY_DEFAULTS].join(" ")}
Hindi, Telugu and Tamil started later and are expected to cost more for now; don't tune rules to cut them.`,
    prompt: `Current numbers:\n${current}\n\nEvidence:\n${evidence.text}`.slice(0, 14000),
    schema: SCHEMA,
    maxTokens: 3000,
  });
  const changes = validateChanges(config, out?.changes);
  const next = mondayOnOrAfter(now + everyDays * DAY);
  await OpsConfig.updateOne(
    { _id: "ops" },
    { $set: { "algorithm.lastReviewAt": new Date(now), "algorithm.nextReviewAt": next, "algorithm.lastSummary": String(out?.summary ?? "").slice(0, 2000) } }
  );
  if (!changes.length) {
    await notice("ads", {
      type: "ads.algorithm_review",
      priority: "normal",
      title: "Algorithm review: no change needed",
      reason: String(out?.summary ?? "").slice(0, 1500),
      effect: `The numbers stay as they are. Next review on ${istDay(next.getTime() + 5.5 * HOUR)}.`,
      payload: { dedupeKey: `alg_review:${istDay(now)}` },
    });
    return { changes: 0 };
  }
  const version = (alg.version ?? 1) + 1;
  const runAt = new Date(now + NOTICE_HOURS * HOUR);
  const card = await propose(
    "ads",
    {
      type: "ads.algorithm_update",
      title: `Algorithm update v${version}: ${changes.length} change${changes.length > 1 ? "s" : ""} to the ads rules`,
      reason: `${String(out?.summary ?? "").slice(0, 1200)}\n${changes.map(changeLine).join("\n")}`,
      effect: `Applies by itself on ${runAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} (2 days' notice); Cancel keeps the current numbers. 14 days later the agent checks the cost per real member and undoes it by itself if it got ${Math.round((WORSE_RATIO - 1) * 100)}%+ worse.`,
      payload: { changes, version, whatsapp: true },
      ref: { kind: "algorithm", id: `v${version}` },
      runAt,
    },
    { dedupeKey: `algorithm:v${version}` }
  );
  return { changes: changes.length, version, card: card?._id ?? null };
};

/** Writes the changes into the config; returns the new version. */
const applyChanges = async (changes, { actionId, kind, ofVersion }) => {
  const config = await getConfig();
  const alg = { ...(config.algorithm ?? {}) };
  const tuning = { ...(alg.tuning ?? {}) };
  for (const c of changes) {
    const s = TUNABLE[c.key];
    if (!s) continue;
    if (s.where === "rules") tuning[c.key] = c.to;
    else if (s.where === "limits") config.set(`limits.${c.key}`, c.to);
    else config.set(`ads.${c.key}`, c.to);
  }
  const version = (alg.version ?? 1) + 1;
  const baseline = await accountWindow(Date.now() - 14 * DAY, Date.now());
  config.algorithm = {
    ...alg,
    tuning,
    version,
    history: [...(alg.history ?? []), { version, at: new Date(), kind, ofVersion: ofVersion ?? null, actionId: actionId ?? null, changes, baseline }].slice(-50),
  };
  config.markModified("algorithm");
  await config.save();
  return version;
};

handle("ads.algorithm_update", async (action) => {
  const version = await applyChanges(action.payload.changes ?? [], { actionId: String(action._id), kind: "update" });
  return { version, applied: (action.payload.changes ?? []).length };
});

handleUndo("ads.algorithm_update", async (action) => {
  const back = (action.payload.changes ?? []).map((c) => ({ ...c, from: c.to, to: c.from }));
  const version = await applyChanges(back, { actionId: String(action._id), kind: "undo", ofVersion: action.result?.version ?? null });
  const config = await getConfig();
  const hist = (config.algorithm?.history ?? []).map((h) => (h.actionId === String(action._id) && h.kind === "update" ? { ...h, reverted: true } : h));
  config.algorithm = { ...config.algorithm, history: hist };
  config.markModified("algorithm");
  await config.save();
  return { version };
});

/** 14 days after an update: kept, or undone by itself when the cost per real member got 15%+ worse. */
export const judgeAlgorithmUpdate = async (now = Date.now()) => {
  const config = await getConfig();
  const hist = config.algorithm?.history ?? [];
  const h = [...hist].reverse().find((x) => x.kind === "update" && !x.judgedAt && !x.reverted && new Date(x.at).getTime() <= now - 14 * DAY);
  if (!h) return null;
  const at = new Date(h.at).getTime();
  const after = await accountWindow(at, at + 14 * DAY);
  const before = h.baseline ?? (await accountWindow(at - 14 * DAY, at));
  const ratio = before.realCpp && after.realCpp ? after.realCpp / before.realCpp : null;
  const worse = ratio != null && ratio >= WORSE_RATIO;
  let undone = false;
  if (worse && h.actionId) undone = !!(await undo(h.actionId, "agent").catch((err) => console.error("[ops] algorithm undo", err.message)));
  await notice("ads", {
    type: "ads.algorithm_result",
    priority: "normal",
    title: worse ? `Algorithm v${h.version} undone: cost per real member rose ${Math.round((ratio - 1) * 100)}%` : `Algorithm v${h.version} kept`,
    reason: `${rs(after.realCpp)} per real member in the 14 days after the update (${after.joined} joins) vs ${rs(before.realCpp)} in the 14 days before (${before.joined}).`,
    effect: worse ? (undone ? "The previous numbers are back. Nothing to do." : "It couldn't be undone by itself: press Pause / undo on the update card.") : "The new numbers stay. Nothing to do.",
    payload: { dedupeKey: `alg_result:v${h.version}`, whatsapp: worse },
  });
  const fresh = await getConfig();
  fresh.algorithm = {
    ...fresh.algorithm,
    history: (fresh.algorithm?.history ?? []).map((x) => (x.version === h.version && x.kind === "update" ? { ...x, judgedAt: new Date(now), after, verdict: worse ? "worse" : "kept" } : x)),
  };
  fresh.markModified("algorithm");
  await fresh.save();
  return worse ? "undone" : "kept";
};

/** Monday job: the 14-day check of the last update, then the review when it's due. */
export const runAlgorithmCycle = async () => {
  const judged = await judgeAlgorithmUpdate().catch((err) => ({ error: err.message }));
  const review = await runAlgorithmReview();
  return { judged, review };
};

/** Once: the first review 30 days from the start. */
export const startAlgorithm = async (now = Date.now()) => {
  const config = await getConfig();
  if (config.algorithm?.nextReviewAt) return null;
  config.algorithm = { version: 1, everyDays: 30, tuning: {}, history: [], ...(config.algorithm ?? {}), nextReviewAt: mondayOnOrAfter(now + 30 * DAY) };
  config.markModified("algorithm");
  await config.save();
  return config.algorithm.nextReviewAt;
};

/** Everything the Ops → Algorithm page shows. */
export const algorithmState = async () => {
  const config = await getConfig();
  const alg = config.algorithm ?? {};
  const history = alg.history ?? [];
  const lastTouched = (key) => [...history].reverse().find((h) => (h.changes ?? []).some((c) => c.key === key))?.version ?? null;
  const pending = await OpsAction.find({ type: "ads.algorithm_update", status: { $in: ["scheduled", "shadow", "needs_you"] } }).sort({ createdAt: -1 }).lean();
  return {
    version: alg.version ?? 1,
    everyDays: alg.everyDays ?? 30,
    lastReviewAt: alg.lastReviewAt ?? null,
    nextReviewAt: alg.nextReviewAt ?? null,
    lastSummary: alg.lastSummary ?? "",
    rules: Object.entries(TUNABLE).map(([key, s]) => ({
      key,
      group: s.group,
      label: s.label,
      unit: s.unit,
      value: valueOf(config, key),
      default: defaultOf(key),
      min: s.min,
      max: s.max,
      changedIn: lastTouched(key),
    })),
    ownerRules: ownerRules(config),
    safetyDefaults: SAFETY_DEFAULTS,
    history: [...history].reverse().slice(0, 20),
    pending,
  };
};

/** Ops → Algorithm: review every 14 or 30 days. */
export const setReviewEvery = async (everyDays) => {
  if (![14, 30].includes(Number(everyDays))) throw Object.assign(new Error("Choose 14 or 30 days"), { status: 400 });
  const config = await getConfig();
  const alg = config.algorithm ?? {};
  const from = alg.lastReviewAt ? new Date(alg.lastReviewAt).getTime() : Date.now();
  config.algorithm = { ...alg, everyDays: Number(everyDays), nextReviewAt: mondayOnOrAfter(Math.max(Date.now(), from + Number(everyDays) * DAY)) };
  config.markModified("algorithm");
  await config.save();
  return config.algorithm;
};
