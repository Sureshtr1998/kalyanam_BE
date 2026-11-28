/*
 * The Meta ads decision rules: pure functions, no I/O, so every rule is
 * unit-tested. The same rules are written out for people (and for Claude
 * Code sessions) in the "meta-ads-playbook" skill; keep the two in step.
 *
 * A "unit" is whatever owns a daily budget: a campaign (budget at campaign
 * level) or an ad set. Each unit carries completed days, oldest first, with
 * Meta's numbers and, when known, `real`: members who actually joined that
 * day in our own database for the unit's language.
 *
 * Principles:
 *  - Judge on 7 days, confirm on 14. Three days of ~10 sign-ups is noise.
 *  - Compare languages with each other (Meta's attribution error cancels
 *    out); judge profit on real joins (Meta misses some).
 *  - Move money from expensive languages to cheap ones before adding any.
 *  - Small steps (≤ 20%) so Meta's learning isn't reset; one budget change
 *    per unit per week; ad and ad-set changes only in batches.
 */

const DAY = 86400000;

export const RULES = {
  // A unit isn't judged for this long after a budget change (the first days after a step are noisy).
  learningDays: 1.5,
  structureLearningDays: 5,
  // Too early to judge below this (7 days).
  minSpend7: 1500,
  minPaid7: 5,
  // Winning also needs this many members in 7 days and the 14-day return holding at 90% of the target.
  minPaidToWin: 10,
  winHold14: 0.9,
  // Return over the last 3 days below 75% of the 4 days before: hold, don't scale.
  slipRatio: 0.75,
  // Losing needs the 14-day cost confirming at 90% of the line.
  loseHold14: 0.9,
  // Fatigue: people saw the ads this often in 7 days, or click rate ≤ 80% of last week's with cost per member up ≥ 15%.
  frequencyTired: 2.5,
  ctrDrop: 0.8,
  cppRise: 1.15,
  // Moving budget between units: donor costs ≥ 20% (7d) and ≥ 10% (14d) more than average, receiver ≥ 15% / 10% less.
  donorRatio7: 1.2,
  donorRatio14: 1.1,
  receiverRatio7: 0.85,
  receiverRatio14: 0.9,
  moveShareDonor: 0.15,
  moveShareReceiver: 0.2,
  minMove: 100,
  maxMoves: 2,
  // No unit is taken below this daily budget.
  minBudget: 500,
  // Only add budget where Meta actually spends what it already has.
  minSpendRate: 0.85,
  // Strong winners step +15% instead of the configured step (never above 20%).
  bigStepRoas: 2,
  maxStepPct: 20,
  // Ads: judged after 7 days and ₹1,500 (or 3 members' worth) over 14 days; paused at ≥ 1.8× the campaign's cost per member.
  adMinAgeDays: 7,
  adMinSpend14: 1500,
  adBadRatio: 1.8,
  // Never leave an ad set with fewer active ads than this; at most this many pauses per ad set per batch.
  adMinActive: 2,
  adMaxPausesPerAdset: 2,
  // Real-joins correction: trusted only with this many Meta members in 14 days, and clamped.
  calibMinPaid: 20,
  calibMin: 1,
  calibMax: 1.3,
  // Per-language real joins from the tags on each ad's link (utm_content), used once tagged
  // sign-ups cover 14 days and number this many; each language's correction is clamped.
  taggedMinJoins14: 40,
  unitCalibMin: 0.5,
  unitCalibMax: 2,
  // Raises: a winner may step again this many days after its last budget change, counted to when the
  // new step goes live (after the notice period): Monday's step runs Tuesday, Thursday's runs Friday.
  raiseGapDays: 3,
  // No unit grows more than this in 7 days (moves in + raises together), so learning isn't reset.
  maxUnitWeekPct: 25,
  // After a brake, no raise for this many days (no see-saw).
  brakeCoolDays: 7,
  // Brake (checked every 3 hours): the last 3 days cost ≥ 2× the 14-day average per member with
  // ≥ ₹3,000 spent → one −step. Ramp-up languages get an alert instead.
  brakeRatio: 2,
  brakeMinSpend3: 3000,
};

/** The engine's numbers as shipped; the monthly review's changes are applied on top (applyTuning). */
export const DEFAULT_RULES = Object.freeze({ ...RULES });

/**
 * The numbers the monthly algorithm review may tune, with hard bounds it can
 * never cross. `where`: RULES (rules), OpsConfig.limits (limits) or
 * OpsConfig.ads (ads). The owner's own rules (all four languages, the daily
 * cap, the ₹500 floor, ramp-up languages, notice periods, funds) are not here.
 */
export const TUNABLE = {
  scaleRoas: { where: "limits", group: "Winning and raises", label: "Return needed before a language is raised", unit: "x", def: 1.5, min: 1.3, max: 2, step: 0.05 },
  minPaidToWin: { where: "rules", group: "Winning and raises", label: "Members in 7 days needed to call a language winning", unit: "", min: 6, max: 15, step: 1 },
  winHold14: { where: "rules", group: "Winning and raises", label: "14-day return needed, as a share of the target", unit: "×", min: 0.8, max: 1, step: 0.05 },
  stepUpPct: { where: "limits", group: "Winning and raises", label: "Size of one raise", unit: "%", def: 10, min: 5, max: 15, step: 1 },
  slipRatio: { where: "rules", group: "Winning and raises", label: "Hold a winner whose last 3 days fall below this share of the 4 before", unit: "×", min: 0.6, max: 0.9, step: 0.05 },
  maxUnitWeekPct: { where: "rules", group: "Winning and raises", label: "Most one language may grow in 7 days", unit: "%", min: 15, max: 30, step: 1 },
  loseHold14: { where: "rules", group: "Losing and cuts", label: "14-day confirmation of losing, as a share of that cost", unit: "×", min: 0.8, max: 1, step: 0.05 },
  stepDownPct: { where: "limits", group: "Losing and cuts", label: "Size of one cut", unit: "%", def: 15, min: 10, max: 20, step: 1 },
  donorRatio7: { where: "rules", group: "Moving money between languages", label: "A giver costs at least this × the average (7 days)", unit: "×", min: 1.1, max: 1.4, step: 0.05 },
  donorRatio14: { where: "rules", group: "Moving money between languages", label: "…and at least this × the average (14 days)", unit: "×", min: 1.05, max: 1.25, step: 0.05 },
  receiverRatio7: { where: "rules", group: "Moving money between languages", label: "A taker costs at most this × the average (7 days)", unit: "×", min: 0.75, max: 0.95, step: 0.05 },
  receiverRatio14: { where: "rules", group: "Moving money between languages", label: "…and at most this × the average (14 days)", unit: "×", min: 0.8, max: 0.95, step: 0.05 },
  moveShareDonor: { where: "rules", group: "Moving money between languages", label: "Most a giver gives in one move (share of its budget)", unit: "×", min: 0.1, max: 0.2, step: 0.01 },
  moveShareReceiver: { where: "rules", group: "Moving money between languages", label: "Most a taker gets in one move (share of its budget)", unit: "×", min: 0.1, max: 0.2, step: 0.01 },
  maxMoves: { where: "rules", group: "Moving money between languages", label: "Moves per week", unit: "", min: 1, max: 3, step: 1 },
  frequencyTired: { where: "rules", group: "Tired ads", label: "Times people saw the ads in 7 days that counts as tired", unit: "", min: 2, max: 3, step: 0.1 },
  ctrDrop: { where: "rules", group: "Tired ads", label: "…or click rate fell to this share of last week's", unit: "×", min: 0.7, max: 0.9, step: 0.05 },
  cppRise: { where: "rules", group: "Tired ads", label: "…while cost per member rose to this × last week's", unit: "×", min: 1.1, max: 1.3, step: 0.05 },
  brakeRatio: { where: "rules", group: "Mid-week brake", label: "Brake when the last 3 days cost this × the 14-day average", unit: "×", min: 1.6, max: 2.5, step: 0.1 },
  brakeMinSpend3: { where: "rules", group: "Mid-week brake", label: "…with at least this much spent in those 3 days", unit: "₹", min: 2000, max: 5000, step: 250 },
  adBadRatio: { where: "rules", group: "Pausing ads", label: "Pause an ad costing this × its campaign per member", unit: "×", min: 1.5, max: 2.5, step: 0.1 },
  adMinSpend14: { where: "rules", group: "Pausing ads", label: "…once it has spent at least this in 14 days", unit: "₹", min: 1000, max: 3000, step: 250 },
  batchEveryDays: { where: "ads", group: "Batches of ad changes", label: "Days between batches of new / paused ads", unit: "days", def: 14, min: 10, max: 21, step: 1 },
};

/** A value moved into its bounds and onto its step. */
export const tuneValue = (key, v) => {
  const s = TUNABLE[key];
  const n = Math.min(s.max, Math.max(s.min, Number(v)));
  return Number((Math.round(n / s.step) * s.step).toFixed(4));
};

/** Puts the reviewed numbers into RULES (back to the shipped values first). Called at the start of every ads run. */
export const applyTuning = (tuning = {}) => {
  for (const [k, v] of Object.entries(DEFAULT_RULES)) RULES[k] = v;
  for (const [k, v] of Object.entries(tuning ?? {})) {
    if (TUNABLE[k]?.where === "rules" && Number.isFinite(Number(v))) RULES[k] = tuneValue(k, v);
  }
};

const LANGS = ["Kannada", "Telugu", "Tamil", "Hindi", "Marathi", "English"];

/**
 * The owner's rule (26 Nov 2026): ads run in all four languages at all
 * times. Budgets and ads may change, but no language is ever left without
 * an active campaign, at least RULES.minBudget a day and RULES.adMinActive
 * running ads; if one is, it's an urgent alert.
 */
export const REQUIRED_LANGUAGES = ["Kannada", "Telugu", "Tamil", "Hindi"];

/**
 * Which required languages have no ads running.
 * @param {{ campaigns: Array<{ id, name, status, dailyBudget }>, adsets: Array<{ id, campaignId, status, dailyBudget }>, ads: Array<{ campaign_id, effective_status }>, languages?: string[] }} p
 * @returns {Array<{ language: string, problem: string }>}
 */
export const languageCoverage = ({ campaigns, adsets, ads, languages = REQUIRED_LANGUAGES }) =>
  languages
    .map((language) => {
      const live = campaigns.filter((c) => c.status === "ACTIVE" && languageOf(c.name) === language);
      if (!live.length) return { language, problem: "no active campaign" };
      const budget = live.reduce((t, c) => t + (c.dailyBudget || 0), 0) + adsets.filter((s) => s.status === "ACTIVE" && live.some((c) => c.id === s.campaignId)).reduce((t, s) => t + (s.dailyBudget || 0), 0);
      if (budget < RULES.minBudget) return { language, problem: `only ₹${Math.round(budget)}/day of budget` };
      const running = ads.filter((a) => a.effective_status === "ACTIVE" && live.some((c) => c.id === a.campaign_id)).length;
      if (running < 1) return { language, problem: "no ads running" };
      return null;
    })
    .filter(Boolean);
/** "SRK | Kannada" → "Kannada" (English when no language is named). */
export const languageOf = (name = "") => LANGS.find((l) => new RegExp(l, "i").test(name)) ?? "English";

const sum = (rows, k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
const roundTo = (n, step) => Math.round(n / step) * step;
const since = (date, now) => (date ? now.getTime() - new Date(date).getTime() : Infinity);
const money = (n) => (Number.isFinite(n) ? `₹${Math.round(n).toLocaleString("en-IN")}` : "∞");
const pct = (r) => `${Math.round(Math.abs(1 - r) * 100)}%`;

/** Totals for a run of days. `cpp` is Meta's cost per paid member. */
export const windowStats = (rows = []) => {
  const spend = sum(rows, "spend");
  const paid = sum(rows, "paid");
  const clicks = sum(rows, "clicks");
  const impressions = sum(rows, "impressions");
  const hasReal = rows.some((r) => r.real != null);
  return {
    days: rows.length,
    spend,
    paid,
    leads: sum(rows, "leads"),
    clicks,
    impressions,
    real: hasReal ? sum(rows, "real") : null,
    cpp: paid ? spend / paid : spend ? Infinity : 0,
    // Link click rate (%), from clicks and impressions rather than Meta's daily ratio.
    ctr: impressions ? (clicks / impressions) * 100 : 0,
  };
};

/**
 * How many real members each Meta-counted member stands for, from the
 * account's last 14 days (joins in our database ÷ Meta's paid count).
 * Clamped, because organic and referral joins are in the database too.
 */
export const calibration = ({ metaPaid, realJoins }) => {
  if (!(metaPaid >= RULES.calibMinPaid) || !(realJoins > 0)) return 1;
  return Math.min(RULES.calibMax, Math.max(RULES.calibMin, realJoins / metaPaid));
};

/** Return on ad spend: real members × net revenue ÷ spend. */
export const roas = (stats, netRevenue, calib = 1) => (stats.spend ? (stats.paid * calib * netRevenue) / stats.spend : 0);

/**
 * One unit's state and flags.
 * States: learning · low_data · losing · winning · healthy.
 * Flags: tired (needs fresh ads; independent of the state).
 * @param {object} unit { id, name, dailyBudget, days, lastChangeAt, lastBudgetChangeAt, lastStructureChangeAt }
 * @param {object} limits OpsConfig.limits
 * @param {Date} now
 * @param {{ calib?: number }} ctx
 */
export const classify = (unit, limits, now = new Date(), { calib: accountCalib = 1 } = {}) => {
  // A language's own correction (from its ad-tagged joins) when there's enough data; else the account's.
  const calib = unit.calib ?? accountCalib;
  const days = unit.days ?? [];
  const w7 = windowStats(days.slice(-7));
  const w14 = windowStats(days.slice(-14));
  const prior7 = windowStats(days.slice(-14, -7));
  const last3 = windowStats(days.slice(-3));
  const prior4 = windowStats(days.slice(-7, -3));
  const net = limits.netRevenuePerMember;
  const realCpp = (w) => (w.paid ? w.spend / (w.paid * calib) : w.spend ? Infinity : 0);

  const metrics = {
    spend7: w7.spend,
    paid7: w7.paid,
    leads7: w7.leads,
    spend14: w14.spend,
    paid14: w14.paid,
    cpp7: w7.cpp,
    cpp14: w14.cpp,
    // Kept for the screens that show the 3-day number.
    cpp3: last3.cpp,
    realCpp7: realCpp(w7),
    realCpp14: realCpp(w14),
    roas7: roas(w7, net, calib),
    roas14: roas(w14, net, calib),
    ctr7: w7.ctr,
    ctrPrior7: prior7.ctr,
    frequency7: days.at(-1)?.frequency7 ?? 0,
    spendRate7: unit.dailyBudget && w7.days ? w7.spend / (w7.days * unit.dailyBudget) : null,
    real7: w7.real,
    real14: w14.real,
    calib,
    calibSource: unit.calibSource ?? "account",
    tagged14: unit.tagged14 ?? null,
  };
  const notes = [];
  const flags = {};

  if (metrics.frequency7 >= RULES.frequencyTired) {
    flags.tired = true;
    notes.push(`People saw these ads ${metrics.frequency7.toFixed(1)} times in 7 days (tired above ${RULES.frequencyTired}).`);
  } else if (
    prior7.paid >= RULES.minPaid7 &&
    prior7.ctr > 0 &&
    w7.ctr <= prior7.ctr * RULES.ctrDrop &&
    w7.cpp >= prior7.cpp * RULES.cppRise
  ) {
    flags.tired = true;
    notes.push(`Click rate down ${pct(w7.ctr / prior7.ctr)} and cost per member up ${pct(w7.cpp / prior7.cpp)} on the week before.`);
  }

  const result = (state, extra = []) => ({ state, flags, metrics, notes: [...extra, ...notes] });

  if (since(unit.lastChangeAt, now) < RULES.learningDays * DAY || since(unit.lastBudgetChangeAt, now) < RULES.learningDays * DAY) {
    return result("learning", [`Budget changed in the last ${RULES.learningDays * 24} hours; judged again after that.`]);
  }
  // New ads restart learning only in their own ad set: the language's budget isn't frozen for them.
  if (since(unit.lastStructureChangeAt, now) < RULES.structureLearningDays * DAY) {
    notes.push(`New or paused ads in the last ${RULES.structureLearningDays} days: those ad sets are re-learning, so costs may wobble.`);
  }
  // Ramp-up languages (owner's rule): judged on their own trend, never against the others.
  if (unit.rampUp) {
    const trend = prior7.paid && w7.paid ? w7.cpp / prior7.cpp : null;
    notes.push(
      `Ramp-up language: ${money(w7.cpp)} per member this week vs ${money(prior7.cpp)} the week before${trend ? ` (${trend <= 1 ? "cheaper" : "dearer"} by ${pct(trend)})` : ""}. It never gives budget away and is never cut.`
    );
  }

  const losingLine = limits.losingCostPerMember;
  const tooEarly = w7.spend < RULES.minSpend7 || (w7.paid < RULES.minPaid7 && w7.spend < 3 * losingLine);
  if (tooEarly) {
    return result("low_data", [`Too early to judge: ${money(w7.spend)} and ${w7.paid} members in 7 days.`]);
  }

  if (metrics.realCpp7 > losingLine && metrics.realCpp14 > losingLine * RULES.loseHold14) {
    if (unit.rampUp) return result("ramping", [`Above the losing line (${money(metrics.realCpp7)} per real member), but it's ramping up: left alone.`]);
    return result("losing", [
      `Real cost per member ${money(metrics.realCpp7)} over 7 days and ${money(metrics.realCpp14)} over 14 (losing above ${money(losingLine)}).`,
    ]);
  }

  if (metrics.roas7 >= limits.scaleRoas && metrics.roas14 >= limits.scaleRoas * RULES.winHold14 && w7.paid >= RULES.minPaidToWin) {
    const slipping = prior4.paid >= 4 && roas(last3, net, calib) < roas(prior4, net, calib) * RULES.slipRatio;
    if (slipping) return result("healthy", ["Return is above target but slipped in the last 3 days; holding."]);
    return result("winning", [`Return ${metrics.roas7.toFixed(2)}x over 7 days and ${metrics.roas14.toFixed(2)}x over 14 (target ${limits.scaleRoas}x).`]);
  }
  return result("healthy");
};

const budgetFree = (u, now) => since(u.lastBudgetChangeAt, now) >= 7 * DAY;
const HOUR = 3600000;
/** True when, by the time a step planned now goes live (after the notice), the last budget change is raiseGapDays old. */
const raiseFree = (u, now, noticeHours = 24) => since(u.lastBudgetChangeAt, now) + noticeHours * HOUR >= RULES.raiseGapDays * DAY - 2 * HOUR;
/** How much the unit's daily budget grew over the last 7 days (1 = not at all). */
const growth7 = (u) => {
  const then = (u.days ?? []).at(-7)?.dailyBudget;
  return then && u.dailyBudget ? u.dailyBudget / then : 1;
};
/** Average cost per member across units: per real member when every unit has ad-tagged joins, else Meta's. */
const avgCost = (list, n, real) => {
  const spend = list.reduce((t, e) => t + e.metrics[`spend${n}`], 0);
  const members = list.reduce((t, e) => t + e.metrics[`paid${n}`] * (real ? e.metrics.calib : 1), 0);
  return members ? spend / members : null;
};

/**
 * Turns unit states into budget decisions, in this order:
 *  1. Moves: expensive → cheap, total daily budget unchanged.
 *  2. Cuts: losing units nobody could take the money from.
 *  3. Raises: winners with headroom and a unit that spends its budget.
 * Prepaid funds are never a reason to raise, cut or hold: the owner keeps the account funded.
 * Fresh ads for tired units are planned separately, on batch days.
 * @param {object} p
 * @param {Array} p.units
 * @param {object} p.limits OpsConfig.limits
 * @param {object} [p.settings] OpsConfig.ads
 * @param {number} [p.increasedThisWeek] rupees of daily budget the agent already added in the last 7 days
 * @param {number} [p.calib] real members per Meta member
 * @param {Date} [p.now]
 */
export const decide = ({ units, limits, settings = {}, increasedThisWeek = 0, calib = 1, now = new Date(), mode = "weekly", noticeHours = limits.adNoticeHours ?? 24 }) => {
  const evaluated = units.map((u) => ({ unit: u, ...classify(u, limits, now, { calib }) }));
  const decisions = [];
  const used = new Set();
  const totalBudget = units.reduce((t, u) => t + (u.dailyBudget || 0), 0);
  const judged = evaluated.filter((e) => e.state !== "learning" && e.state !== "low_data" && e.metrics.paid7 > 0);
  // Compare languages per real member (ad-tagged joins) once every language has them; Meta's count until then.
  const real = judged.length > 0 && judged.every((e) => e.metrics.calibSource === "tagged");
  const cost = (e, n) => (real ? e.metrics[`realCpp${n}`] : e.metrics[`cpp${n}`]);
  const avg7 = avgCost(judged, 7, real);
  const avg14 = avgCost(judged, 14, real);
  const weekly = mode === "weekly";

  // 1. Moves between units (Mondays only). Ramp-up languages never give budget away.
  if (weekly && settings.rebalance !== false && avg7 && avg14) {
    const movable = (e) => e.state !== "learning" && e.state !== "low_data" && e.unit.dailyBudget > 0 && budgetFree(e.unit, now);
    const donors = evaluated
      .filter(
        (e) =>
          movable(e) &&
          !e.unit.rampUp &&
          cost(e, 7) >= RULES.donorRatio7 * avg7 &&
          cost(e, 14) >= RULES.donorRatio14 * avg14 &&
          e.unit.dailyBudget - RULES.minMove >= RULES.minBudget
      )
      .sort((a, b) => cost(b, 7) - cost(a, 7));
    const receivers = evaluated
      .filter(
        (e) =>
          movable(e) &&
          e.state !== "losing" &&
          cost(e, 7) <= RULES.receiverRatio7 * avg7 &&
          cost(e, 14) <= RULES.receiverRatio14 * avg14 &&
          (e.metrics.spendRate7 == null || e.metrics.spendRate7 >= RULES.minSpendRate) &&
          e.metrics.frequency7 < RULES.frequencyTired
      )
      .sort((a, b) => cost(a, 7) - cost(b, 7));

    for (const d of donors) {
      if (decisions.filter((x) => x.type === "ads.rebalance").length >= RULES.maxMoves) break;
      const r = receivers.find((x) => !used.has(x.unit.id) && x.unit.id !== d.unit.id);
      if (!r) break;
      // Our own joins must agree: the donor's real cost per member is higher than the receiver's.
      const realCost = (e) => (e.metrics.real14 ? e.metrics.spend14 / e.metrics.real14 : null);
      if (realCost(d) != null && realCost(r) != null && realCost(d) <= realCost(r)) {
        d.notes.push(`Would move budget to ${r.unit.name}, but our own joins don't confirm it is cheaper.`);
        continue;
      }
      let amount = roundTo(Math.min(d.unit.dailyBudget * RULES.moveShareDonor, r.unit.dailyBudget * RULES.moveShareReceiver), 50);
      amount = Math.min(amount, d.unit.dailyBudget - RULES.minBudget);
      if (amount < RULES.minMove) continue;
      used.add(d.unit.id);
      used.add(r.unit.id);
      const dFrom = d.unit.dailyBudget;
      const rFrom = r.unit.dailyBudget;
      decisions.push({
        type: "ads.rebalance",
        unitId: d.unit.id,
        title: `Move ₹${amount}/day from ${d.unit.name} to ${r.unit.name}`,
        reason:
          `${d.unit.name} costs ${money(cost(d, 7))} per ${real ? "real " : ""}member over 7 days (${money(cost(d, 14))} over 14); ` +
          `${r.unit.name} costs ${money(cost(r, 7))} (${money(cost(r, 14))}). Average ${money(avg7)}. ` +
          `${r.unit.name} spends ${Math.round((r.metrics.spendRate7 ?? 1) * 100)}% of its budget, so it can use more. ` +
          `Total daily budget stays the same; both steps are under 20%, so Meta's learning isn't reset.`,
        effect: `${d.unit.name} ₹${dFrom} → ₹${dFrom - amount}/day; ${r.unit.name} ₹${rFrom} → ₹${rFrom + amount}/day.`,
        payload: {
          entityId: d.unit.id,
          moves: [
            { entityId: d.unit.id, name: d.unit.name, level: d.unit.level, from: dFrom, to: dFrom - amount },
            { entityId: r.unit.id, name: r.unit.name, level: r.unit.level, from: rFrom, to: rFrom + amount },
          ],
        },
      });
    }
  }

  // 2. Cuts for losing units whose money nobody took (Mondays only; ramp-up languages are never "losing").
  for (const e of evaluated.filter((x) => weekly && x.state === "losing" && !x.unit.rampUp && !used.has(x.unit.id))) {
    const u = e.unit;
    if (!u.dailyBudget || !budgetFree(u, now)) continue;
    const next = Math.max(RULES.minBudget, roundTo(u.dailyBudget * (1 - limits.stepDownPct / 100), 10));
    if (next >= u.dailyBudget) continue;
    used.add(u.id);
    decisions.push({
      type: "ads.budget",
      unitId: u.id,
      title: `Lower ${u.name} to ₹${next}/day`,
      reason: `${e.notes.join(" ")} No cheaper language could use the money, so it is saved. A −${limits.stepDownPct}% step limits the loss without restarting learning.`,
      effect: `Daily budget ₹${u.dailyBudget} → ₹${next}.`,
      payload: { entityId: u.id, level: u.level, from: u.dailyBudget, to: next },
    });
  }

  // 3. Raises for winners.
  const weekBase = Math.max(0, totalBudget - increasedThisWeek);
  let headroom = Math.min(limits.maxDailySpend - totalBudget, (weekBase * limits.maxWeeklyIncreasePct) / 100 - increasedThisWeek);

  const winners = evaluated.filter((e) => e.state === "winning" && !used.has(e.unit.id)).sort((a, b) => b.metrics.roas7 - a.metrics.roas7);
  for (const e of winners) {
    const u = e.unit;
    if (!u.dailyBudget) continue;
    if (!raiseFree(u, now, noticeHours)) {
      e.notes.push(`Budget changed recently; the next step can go live ${RULES.raiseGapDays} days after the last one.`);
      continue;
    }
    if (since(u.lastBrakeAt, now) < RULES.brakeCoolDays * DAY) {
      e.notes.push(`Braked in the last ${RULES.brakeCoolDays} days; not raised again so soon.`);
      continue;
    }
    // A tired audience mostly buys repeat views: raise once fresh ads have landed.
    if (e.metrics.frequency7 >= RULES.frequencyTired && !(since(u.lastLaunchAt, now) < 7 * DAY)) {
      e.notes.push(`Would scale, but people already see these ads ${e.metrics.frequency7.toFixed(1)} times a week; it scales after fresh ads go live.`);
      continue;
    }
    if (e.metrics.spendRate7 != null && e.metrics.spendRate7 < RULES.minSpendRate) {
      e.notes.push(`Would scale, but it spends only ${Math.round(e.metrics.spendRate7 * 100)}% of its budget; more budget wouldn't be used.`);
      continue;
    }
    const strong = e.metrics.roas7 >= RULES.bigStepRoas && e.metrics.roas14 >= RULES.bigStepRoas * RULES.winHold14;
    const step = Math.min(RULES.maxStepPct, strong ? Math.max(limits.stepUpPct, 15) : limits.stepUpPct);
    const next = roundTo(u.dailyBudget * (1 + step / 100), 10);
    const delta = next - u.dailyBudget;
    // Moves in and raises together stay within +25% a week for one unit.
    if (growth7(u) * (next / u.dailyBudget) > 1 + RULES.maxUnitWeekPct / 100 + 0.001) {
      e.notes.push(`Already up ${Math.round((growth7(u) - 1) * 100)}% this week; the next step waits so Meta's learning isn't reset.`);
      continue;
    }
    if (delta <= 0 || delta > headroom) {
      e.notes.push("Would scale, but the daily spend or weekly increase limit is reached.");
      continue;
    }
    headroom -= delta;
    used.add(u.id);
    decisions.push({
      type: "ads.budget",
      unitId: u.id,
      title: `Raise ${u.name} to ₹${next}/day`,
      reason: `${e.notes.join(" ")} Members 7d: ${e.metrics.paid7} on Meta (≈${Math.round(e.metrics.paid7 * calib)} real), cost per member ${money(e.metrics.cpp7)}. A +${step}% step keeps Meta's learning intact; nothing else is touched.`,
      effect: `Daily budget ₹${u.dailyBudget} → ₹${next} (+₹${delta}).`,
      payload: { entityId: u.id, level: u.level, from: u.dailyBudget, to: next },
    });
  }

  return { evaluated, decisions, totalBudget, average: { cpp7: avg7, cpp14: avg14, real }, calib };
};

/**
 * The mid-week brake, checked every 3 hours: a unit whose last 3 complete days
 * cost at least RULES.brakeRatio × its 14-day average per member (or brought no
 * members) with at least RULES.brakeMinSpend3 spent gets one −step, without
 * waiting for Monday. Ramp-up languages get an urgent alert instead of a cut.
 * @param {{ units: Array, limits: object, now?: Date }} p
 * @returns {{ decisions: Array, alerts: Array<{ unit: object, why: string }> }}
 */
export const brakes = ({ units, limits, now = new Date(), noticeHours = limits.adNoticeHours ?? 24 }) => {
  const decisions = [];
  const alerts = [];
  for (const u of units) {
    if (!u.dailyBudget) continue;
    const days = u.days ?? [];
    const last3 = windowStats(days.slice(-3));
    const w14 = windowStats(days.slice(-14));
    if (last3.spend < RULES.brakeMinSpend3 || w14.paid < RULES.minPaid7 || !Number.isFinite(w14.cpp)) continue;
    if (!(last3.paid === 0 || last3.cpp >= RULES.brakeRatio * w14.cpp)) continue;
    if (!raiseFree(u, now, noticeHours)) continue;
    // New or paused ads make costs wobble for a few days while Meta learns them: not a reason to brake.
    if (since(u.lastStructureChangeAt, now) < RULES.structureLearningDays * DAY) continue;
    const why = `Last 3 days: ${money(last3.spend)} for ${last3.paid} member${last3.paid === 1 ? "" : "s"}${last3.paid ? ` (${money(last3.cpp)} each)` : ""}, against ${money(w14.cpp)} per member over 14 days.`;
    if (u.rampUp) {
      alerts.push({ unit: u, why });
      continue;
    }
    const next = Math.max(RULES.minBudget, roundTo(u.dailyBudget * (1 - limits.stepDownPct / 100), 10));
    if (next >= u.dailyBudget) continue;
    decisions.push({
      type: "ads.budget",
      unitId: u.id,
      title: `Brake: lower ${u.name} to ₹${next}/day`,
      reason: `${why} A −${limits.stepDownPct}% step limits the loss while it's checked; Monday's review decides the rest.`,
      effect: `Daily budget ₹${u.dailyBudget} → ₹${next}.`,
      payload: { entityId: u.id, level: u.level, from: u.dailyBudget, to: next, brake: true },
    });
  }
  return { decisions, alerts };
};

/** Which language an ad-tagged sign-up came from: the tag on the ad's link (kn_…, ta_…, telugu_brand…). */
export const tagLanguage = ({ utmContent = "", utmCampaign = "" } = {}) => {
  const c = String(utmContent || "").toLowerCase();
  if (/^(kn|kannada)[_-]/.test(c)) return "Kannada";
  if (/^(te|telugu)[_-]/.test(c)) return "Telugu";
  if (/^(ta|tamil)[_-]/.test(c)) return "Tamil";
  if (/^(hi|hindi)[_-]/.test(c)) return "Hindi";
  const camp = String(utmCampaign || "").toLowerCase();
  if (/(_hi$|hindi)/.test(camp)) return "Hindi";
  if (/(nov26|kannada|_kn$)/.test(camp)) return "Kannada";
  return null;
};

/**
 * Each language's own real-joins correction from ad-tagged sign-ups: the
 * account's real ad members (Meta's total × the account correction) shared out
 * by each language's share of tagged sign-ups, over its Meta-counted members.
 * @param {{ metaPaid: Record<string, number>, tagged: Record<string, number>, accountCalib: number }} p
 * @returns {Record<string, number> | null} null when there are too few tagged sign-ups
 */
export const languageCalibration = ({ metaPaid, tagged, accountCalib = 1 }) => {
  const taggedTotal = Object.values(tagged).reduce((t, n) => t + n, 0);
  const metaTotal = Object.values(metaPaid).reduce((t, n) => t + n, 0);
  if (taggedTotal < RULES.taggedMinJoins14 || !metaTotal) return null;
  const out = {};
  for (const [lang, paid] of Object.entries(metaPaid)) {
    if (!paid) continue;
    const realMembers = metaTotal * accountCalib * ((tagged[lang] ?? 0) / taggedTotal);
    out[lang] = Math.min(RULES.unitCalibMax, Math.max(RULES.unitCalibMin, realMembers / paid));
  }
  return out;
};

/**
 * Ads to pause: at least 7 days old, enough spend over 14 days, and costing
 * ≥ 1.8× their campaign's cost per member (or nothing at all). Never leaves an
 * ad set with fewer than 2 active ads.
 * @param {{ ads: Array<{ id, name, adsetId, campaignId, createdAt, spend14, paid14 }>, campaignCpp14: Map<string, number>, now?: Date }} p
 * @returns {{ pauses: Array, thin: Array<{ adsetId, campaignId, active: number }> }}
 */
export const adDecisions = ({ ads, campaignCpp14, now = new Date() }) => {
  const pauses = [];
  const thin = [];
  const byAdset = new Map();
  for (const a of ads) {
    if (!byAdset.has(a.adsetId)) byAdset.set(a.adsetId, []);
    byAdset.get(a.adsetId).push(a);
  }
  for (const [adsetId, list] of byAdset) {
    const campaignId = list[0].campaignId;
    const ref = campaignCpp14.get(campaignId);
    let active = list.length;
    if (ref && Number.isFinite(ref)) {
      const cpp = (a) => (a.paid14 ? a.spend14 / a.paid14 : Infinity);
      const bad = list
        .filter(
          (a) =>
            since(a.createdAt, now) >= RULES.adMinAgeDays * DAY &&
            a.spend14 >= Math.max(RULES.adMinSpend14, 3 * ref) &&
            cpp(a) >= RULES.adBadRatio * ref
        )
        .sort((a, b) => cpp(b) - cpp(a) || b.spend14 - a.spend14);
      for (const a of bad.slice(0, RULES.adMaxPausesPerAdset)) {
        if (active <= RULES.adMinActive) break;
        active--;
        pauses.push({
          adId: a.id,
          adsetId,
          campaignId,
          name: a.name,
          reason: `${a.name}: ${money(a.spend14)} for ${a.paid14} members in 14 days (${money(cpp(a))} each) vs ${money(ref)} for its campaign.`,
        });
      }
    }
    if (active <= RULES.adMinActive) thin.push({ adsetId, campaignId, active });
  }
  return { pauses, thin };
};

const ACCOUNT_STATUS = { 2: "disabled", 3: "unsettled (a payment failed)", 7: "under risk review", 8: "pending settlement", 9: "in a grace period", 100: "pending closure", 101: "closed" };
/** Account states caused by payments: funds are the owner's to handle, so these aren't sent to WhatsApp. */
const PAYMENT_STATUSES = new Set([3, 8, 9]);

/**
 * Alarms that can't wait for the weekly cycle. Urgent ones are emailed to the owner.
 * @param {object} p
 * @param {object} [p.today] today's account snapshot row
 * @param {number} [p.budgetTotal] sum of active daily budgets
 * @param {number} [p.accountStatus] Meta account_status
 * @param {Array} [p.adIssues] ads that are disapproved or have delivery issues
 * @param {number|null} [p.yesterdaySpend]
 * @param {Array<{ language: string, problem: string }>} [p.uncovered] required languages with no ads running (languageCoverage)
 */
export const emergencies = ({ today, budgetTotal, accountStatus, adIssues = [], yesterdaySpend = null, uncovered = [] }) => {
  const out = [];
  if (uncovered.length) {
    out.push({
      type: "ads.language_gap",
      priority: "urgent",
      title: `Ads aren't running in ${uncovered.map((u) => u.language).join(", ")}`,
      reason: `Your rule: ads run in all 4 languages at all times. ${uncovered.map((u) => `${u.language}: ${u.problem}`).join("; ")}.`,
      effect: "Turn that language's campaign back on in Ads Manager (or add ads/budget). The agent never turns a language off.",
    });
  }
  if (accountStatus != null && accountStatus !== 1) {
    out.push({
      type: "ads.account_status",
      priority: "urgent",
      title: `Meta ad account is ${ACCOUNT_STATUS[accountStatus] ?? `in status ${accountStatus}`}`,
      reason: "No ads deliver until this is fixed.",
      effect: "Open Meta Billing / Account quality and fix it. Alert only.",
      ...(PAYMENT_STATUSES.has(accountStatus) ? { whatsapp: false } : {}),
    });
  }
  const disapproved = adIssues.filter((a) => a.effective_status === "DISAPPROVED");
  if (disapproved.length) {
    out.push({
      type: "ads.disapproved",
      priority: "urgent",
      title: `${disapproved.length} ad${disapproved.length > 1 ? "s" : ""} disapproved by Meta`,
      reason: disapproved.map((a) => `${a.name}${a.issue ? `: ${a.issue}` : ""}`).join("; ").slice(0, 600),
      effect: "Fix the ad or request a review in Ads Manager (Account quality). Alert only.",
    });
  }
  const issues = adIssues.filter((a) => a.effective_status === "WITH_ISSUES");
  if (issues.length) {
    out.push({
      type: "ads.issues",
      priority: "normal",
      title: `${issues.length} ad${issues.length > 1 ? "s have" : " has"} delivery issues`,
      reason: issues.map((a) => `${a.name}${a.issue ? `: ${a.issue}` : ""}`).join("; ").slice(0, 600),
      effect: "Alert only.",
    });
  }
  if (yesterdaySpend != null && budgetTotal >= 1000 && yesterdaySpend < budgetTotal * 0.4) {
    out.push({
      type: "ads.delivery_stalled",
      priority: "urgent",
      title: `Ads spent only ₹${Math.round(yesterdaySpend)} yesterday (budgets ₹${Math.round(budgetTotal)})`,
      reason: "Under 40% of the daily budgets went out. Usual causes: an account spending limit, disapproved ads, a payment problem or a billing hold.",
      effect: "Check Ads Manager → Delivery and Billing. Alert only.",
      // Prepaid funds below a day's budgets explain it: funds are the owner's, so no WhatsApp.
      ...(today?.funds != null && today.funds < budgetTotal ? { whatsapp: false } : {}),
    });
  }
  if (today && budgetTotal > 0 && today.spend > budgetTotal * 1.5) {
    out.push({
      type: "ads.overspend",
      priority: "urgent",
      title: `Today's spend ₹${Math.round(today.spend)} is over 150% of budget`,
      reason: `Daily budgets add up to ₹${Math.round(budgetTotal)}. Meta can overspend a day by up to 75%, but this is worth a look.`,
      effect: "Alert only.",
    });
  }
  return out;
};

/**
 * Whether ad and ad-set changes (new ads, paused ads, new ad sets) may be
 * scheduled now: after the owner's hands-off date and at least
 * `batchEveryDays` after the last batch.
 * @param {{ settings?: { handsOffUntil?: Date|string|null, batchEveryDays?: number }, lastBatchAt?: Date|string|null, now?: Date }} p
 */
export const batchGate = ({ settings = {}, lastBatchAt = null, now = new Date() }) => {
  if (settings.handsOffUntil && new Date(settings.handsOffUntil) > now) {
    return { open: false, reason: `Hands off until ${new Date(settings.handsOffUntil).toISOString().slice(0, 10)} (owner's rule).` };
  }
  const every = settings.batchEveryDays ?? 14;
  if (lastBatchAt && since(lastBatchAt, now) < (every - 0.5) * DAY) {
    const next = new Date(new Date(lastBatchAt).getTime() + every * DAY);
    return { open: false, reason: `Last batch of ad changes was ${new Date(lastBatchAt).toISOString().slice(0, 10)}; next one from ${next.toISOString().slice(0, 10)}.` };
  }
  return { open: true };
};
