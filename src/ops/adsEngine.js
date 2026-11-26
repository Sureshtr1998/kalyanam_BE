/*
 * The campaign rules, as pure functions so they can be tested without Meta.
 *
 * A "unit" is whatever owns the budget: an ad set with its own daily budget,
 * or a campaign whose budget is shared by its ad sets. Each unit gets a state
 * from its last days of numbers, then the rules turn states into decisions:
 *
 *  learning — changed in the last 3 days: never touched
 *  winning  — 7-day return ≥ scaleRoas and not slipping: +stepUpPct once a week
 *  healthy  — paying its way: left alone
 *  tired    — 7-day frequency > 2.5 or click rate down 3 days running: creative refresh
 *  losing   — cost per paid member above the limit over 3 days: −stepDownPct once a week
 *
 * Budget increases also respect the account-wide limits (max daily spend,
 * max weekly increase, minimum days of prepaid funds left).
 */

const DAY = 86400000;
const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
const roundTo10 = (n) => Math.round(n / 10) * 10;

/** Return on spend: paid members × net revenue ÷ spend. */
export const roas = (rows, netRevenue) => {
  const spend = sum(rows, "spend");
  return spend ? (sum(rows, "paid") * netRevenue) / spend : 0;
};

/** Cost per paid member, Infinity when money was spent with no joins. */
export const costPerPaid = (rows) => {
  const spend = sum(rows, "spend");
  const paid = sum(rows, "paid");
  return paid ? spend / paid : spend ? Infinity : 0;
};

/**
 * @param {object} unit { id, name, dailyBudget, days: [{date, spend, paid, leads, ctr, frequency7}] (oldest first, completed days only), lastChangeAt }
 * @param {object} limits OpsConfig.limits
 * @param {Date} now
 */
export const classify = (unit, limits, now = new Date()) => {
  const days = unit.days ?? [];
  const last7 = days.slice(-7);
  const last3 = days.slice(-3);
  const prior4 = days.slice(-7, -3);
  const metrics = {
    spend7: sum(last7, "spend"),
    paid7: sum(last7, "paid"),
    leads7: sum(last7, "leads"),
    roas7: roas(last7, limits.netRevenuePerMember),
    cpp7: costPerPaid(last7),
    cpp3: costPerPaid(last3),
    frequency7: days.at(-1)?.frequency7 ?? 0,
  };
  const notes = [];

  const sinceChange = unit.lastChangeAt ? now.getTime() - new Date(unit.lastChangeAt).getTime() : Infinity;
  if (sinceChange < 3 * DAY) {
    return { state: "learning", metrics, notes: ["Changed in the last 3 days; judged from day 3."] };
  }
  if (metrics.spend7 < 500) {
    return { state: "healthy", metrics, notes: ["Too little spend in 7 days to judge."] };
  }

  const ctrFalling =
    last3.length === 3 && last3[0].ctr > last3[1].ctr && last3[1].ctr > last3[2].ctr && last3[2].ctr > 0;
  const tired = metrics.frequency7 > 2.5 || ctrFalling;
  if (metrics.frequency7 > 2.5) notes.push(`7-day frequency ${metrics.frequency7.toFixed(2)} (over 2.5).`);
  if (ctrFalling) notes.push("Click rate fell 3 days in a row.");

  const losing = sum(last3, "spend") >= 1000 && metrics.cpp3 > limits.losingCostPerMember;
  if (losing) {
    notes.push(`Cost per paid member ₹${Number.isFinite(metrics.cpp3) ? Math.round(metrics.cpp3) : "∞"} over 3 days (limit ₹${limits.losingCostPerMember}).`);
    return { state: "losing", metrics, notes };
  }
  if (tired) return { state: "tired", metrics, notes };

  const slipping =
    prior4.length === 4 && roas(last3, limits.netRevenuePerMember) < roas(prior4, limits.netRevenuePerMember) * 0.85;
  if (metrics.roas7 >= limits.scaleRoas && metrics.paid7 >= 5) {
    if (slipping) {
      notes.push("Return is above target but slipping in the last 3 days; holding.");
      return { state: "healthy", metrics, notes };
    }
    notes.push(`Return ${metrics.roas7.toFixed(2)}x over 7 days (target ${limits.scaleRoas}x).`);
    return { state: "winning", metrics, notes };
  }
  return { state: "healthy", metrics, notes };
};

/**
 * Turns unit states into decisions.
 * @param {object} p
 * @param {Array} p.units units with { id, name, campaignName, level, dailyBudget, days, lastChangeAt, lastBudgetChangeAt }
 * @param {object} p.limits
 * @param {{ available: number|null, avgDailySpend: number }} p.funds
 * @param {number} p.increasedThisWeek ₹ of daily budget the agent already added in the last 7 days
 * @param {Date} [p.now]
 */
export const decide = ({ units, limits, funds, increasedThisWeek = 0, now = new Date() }) => {
  const evaluated = units.map((u) => ({ unit: u, ...classify(u, limits, now) }));
  const decisions = [];
  const totalBudget = units.reduce((t, u) => t + (u.dailyBudget || 0), 0);
  const runway = funds?.available != null && funds.avgDailySpend > 0 ? funds.available / funds.avgDailySpend : null;
  // Budget at the start of the week, so the weekly cap doesn't grow with itself.
  const weekBase = Math.max(0, totalBudget - increasedThisWeek);
  let headroom = Math.min(
    limits.maxDailySpend - totalBudget,
    (weekBase * limits.maxWeeklyIncreasePct) / 100 - increasedThisWeek
  );

  const budgetChangedRecently = (u) =>
    u.lastBudgetChangeAt && now.getTime() - new Date(u.lastBudgetChangeAt).getTime() < 7 * DAY;

  // Best return first, so limited headroom goes to the strongest unit.
  const winners = evaluated.filter((e) => e.state === "winning").sort((a, b) => b.metrics.roas7 - a.metrics.roas7);
  for (const e of winners) {
    const u = e.unit;
    const why = e.notes.join(" ");
    if (!u.dailyBudget) continue;
    if (budgetChangedRecently(u)) {
      e.notes.push("Budget already changed this week; next step after 7 days.");
      continue;
    }
    if (runway != null && runway < limits.minRunwayDays) {
      e.notes.push(`Would scale, but prepaid funds cover only ${runway.toFixed(1)} days.`);
      continue;
    }
    const next = roundTo10(u.dailyBudget * (1 + limits.stepUpPct / 100));
    const delta = next - u.dailyBudget;
    if (delta <= 0 || delta > headroom) {
      e.notes.push("Would scale, but the daily spend or weekly increase limit is reached.");
      continue;
    }
    headroom -= delta;
    decisions.push({
      type: "ads.budget",
      unitId: u.id,
      title: `Raise ${u.name} to ₹${next}/day`,
      reason: `${why} Paid members 7d: ${e.metrics.paid7}, cost per member ₹${Math.round(e.metrics.cpp7)}. A +${limits.stepUpPct}% step keeps Meta's learning intact; nothing else in the campaign is touched.`,
      effect: `Daily budget ₹${u.dailyBudget} → ₹${next} (+₹${delta}).`,
      payload: { entityId: u.id, level: u.level, from: u.dailyBudget, to: next },
    });
  }

  for (const e of evaluated.filter((x) => x.state === "losing")) {
    const u = e.unit;
    if (!u.dailyBudget || budgetChangedRecently(u)) continue;
    const next = Math.max(200, roundTo10(u.dailyBudget * (1 - limits.stepDownPct / 100)));
    if (next >= u.dailyBudget) continue;
    decisions.push({
      type: "ads.budget",
      unitId: u.id,
      title: `Lower ${u.name} to ₹${next}/day`,
      reason: `${e.notes.join(" ")} A −${limits.stepDownPct}% step limits the loss without restarting learning. Winning ad sets are not touched.`,
      effect: `Daily budget ₹${u.dailyBudget} → ₹${next}.`,
      payload: { entityId: u.id, level: u.level, from: u.dailyBudget, to: next },
    });
  }

  for (const e of evaluated.filter((x) => x.state === "tired")) {
    decisions.push({
      type: "ads.creative_refresh",
      unitId: e.unit.id,
      title: `Fresh creatives for ${e.unit.name}`,
      reason: `${e.notes.join(" ")} The same people keep seeing the same ads. Swap the weakest ads for new versions of the best ones on the next change day.`,
      effect: "Queued for the next change day (all ad changes are batched, then hands off for 7 days).",
      payload: { entityId: e.unit.id },
    });
  }

  return { evaluated, decisions, runway, totalBudget };
};

/** Account-level alarms that can't wait for the weekly cycle. */
export const emergencies = ({ funds, today, budgetTotal }) => {
  const out = [];
  if (funds?.available != null && funds.avgDailySpend > 0) {
    const days = funds.available / funds.avgDailySpend;
    if (days < 3) {
      out.push({
        type: "ads.funds_low",
        priority: "urgent",
        title: days < 1 ? "Meta ads stop today: top up now" : `Meta funds last ~${days.toFixed(1)} days`,
        reason: `Prepaid balance ₹${Math.round(funds.available)} at ~₹${Math.round(funds.avgDailySpend)}/day. Ads pause when it hits zero and restart in learning.`,
        effect: "Top up in Meta Billing. The agent cannot pay for you.",
      });
    }
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
