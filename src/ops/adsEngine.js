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
  // Days a unit is left alone after a budget change / an ad or ad-set change.
  learningDays: 3,
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
export const classify = (unit, limits, now = new Date(), { calib = 1 } = {}) => {
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
    return result("learning", [`Changed in the last ${RULES.learningDays} days; judged again after that.`]);
  }
  if (since(unit.lastStructureChangeAt, now) < RULES.structureLearningDays * DAY) {
    return result("learning", [`Ads changed in the last ${RULES.structureLearningDays} days; Meta is still learning.`]);
  }

  const losingLine = limits.losingCostPerMember;
  const tooEarly = w7.spend < RULES.minSpend7 || (w7.paid < RULES.minPaid7 && w7.spend < 3 * losingLine);
  if (tooEarly) {
    return result("low_data", [`Too early to judge: ${money(w7.spend)} and ${w7.paid} members in 7 days.`]);
  }

  if (metrics.realCpp7 > losingLine && metrics.realCpp14 > losingLine * RULES.loseHold14) {
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
const avgCpp = (list, key) => {
  const spend = list.reduce((t, e) => t + e.metrics[key === "cpp7" ? "spend7" : "spend14"], 0);
  const paid = list.reduce((t, e) => t + e.metrics[key === "cpp7" ? "paid7" : "paid14"], 0);
  return paid ? spend / paid : null;
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
export const decide = ({ units, limits, settings = {}, increasedThisWeek = 0, calib = 1, now = new Date() }) => {
  const evaluated = units.map((u) => ({ unit: u, ...classify(u, limits, now, { calib }) }));
  const decisions = [];
  const used = new Set();
  const totalBudget = units.reduce((t, u) => t + (u.dailyBudget || 0), 0);
  const judged = evaluated.filter((e) => e.state !== "learning" && e.state !== "low_data" && e.metrics.paid7 > 0);
  const avg7 = avgCpp(judged, "cpp7");
  const avg14 = avgCpp(judged, "cpp14");

  // 1. Moves between units.
  if (settings.rebalance !== false && avg7 && avg14) {
    const movable = (e) => e.state !== "learning" && e.state !== "low_data" && e.unit.dailyBudget > 0 && budgetFree(e.unit, now);
    const donors = evaluated
      .filter(
        (e) =>
          movable(e) &&
          e.metrics.cpp7 >= RULES.donorRatio7 * avg7 &&
          e.metrics.cpp14 >= RULES.donorRatio14 * avg14 &&
          e.unit.dailyBudget - RULES.minMove >= RULES.minBudget
      )
      .sort((a, b) => b.metrics.cpp7 - a.metrics.cpp7);
    const receivers = evaluated
      .filter(
        (e) =>
          movable(e) &&
          e.state !== "losing" &&
          e.metrics.cpp7 <= RULES.receiverRatio7 * avg7 &&
          e.metrics.cpp14 <= RULES.receiverRatio14 * avg14 &&
          (e.metrics.spendRate7 == null || e.metrics.spendRate7 >= RULES.minSpendRate) &&
          e.metrics.frequency7 < RULES.frequencyTired
      )
      .sort((a, b) => a.metrics.cpp7 - b.metrics.cpp7);

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
          `${d.unit.name} costs ${money(d.metrics.cpp7)} per member over 7 days (${money(d.metrics.cpp14)} over 14); ` +
          `${r.unit.name} costs ${money(r.metrics.cpp7)} (${money(r.metrics.cpp14)}). Average ${money(avg7)}. ` +
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

  // 2. Cuts for losing units whose money nobody took.
  for (const e of evaluated.filter((x) => x.state === "losing" && !used.has(x.unit.id))) {
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
    if (!budgetFree(u, now)) {
      e.notes.push("Budget already changed this week; next step after 7 days.");
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

  return { evaluated, decisions, totalBudget, average: { cpp7: avg7, cpp14: avg14 }, calib };
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
