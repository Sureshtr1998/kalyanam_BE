import { describe, expect, it } from "vitest";
import { classify, decide, emergencies } from "../src/ops/adsEngine.js";

const limits = {
  maxDailySpend: 10000,
  maxWeeklyIncreasePct: 25,
  stepUpPct: 10,
  stepDownPct: 15,
  scaleRoas: 1.5,
  netRevenuePerMember: 285,
  losingCostPerMember: 420,
  minRunwayDays: 5,
};
const now = new Date("2026-12-10T06:00:00Z");
const days = (n, row) => Array.from({ length: n }, (_, i) => ({ date: `2026-12-0${i + 1}`, ctr: 4, frequency7: 1.8, ...row }));

describe("classify", () => {
  it("leaves a recently changed unit alone", () => {
    const r = classify({ days: days(7, { spend: 1000, paid: 8 }), lastChangeAt: new Date(now.getTime() - 86400000) }, limits, now);
    expect(r.state).toBe("learning");
  });

  it("calls a unit at ₹125 per member winning", () => {
    // 7 × ₹1,000 spend, 8 paid a day → ₹125/member → 2.28x return
    const r = classify({ days: days(7, { spend: 1000, paid: 8 }) }, limits, now);
    expect(r.state).toBe("winning");
  });

  it("does not scale on the user's current ~₹245 per member (1.16x)", () => {
    const r = classify({ days: days(7, { spend: 1680, paid: 7 }) }, limits, now);
    expect(r.state).toBe("healthy");
  });

  it("flags losing after 3 days over ₹420 per member", () => {
    const r = classify({ days: days(7, { spend: 1500, paid: 3 }) }, limits, now);
    expect(r.state).toBe("losing");
  });

  it("flags tired on high frequency", () => {
    const r = classify({ days: days(7, { spend: 1000, paid: 5, frequency7: 2.7 }) }, limits, now);
    expect(r.state).toBe("tired");
  });

  it("holds a winner whose return is slipping", () => {
    const d = [...days(4, { spend: 1000, paid: 10 }), ...days(3, { spend: 1000, paid: 5 })];
    expect(classify({ days: d }, limits, now).state).toBe("healthy");
  });
});

describe("decide", () => {
  const winner = { id: "w", name: "KN", level: "campaign", dailyBudget: 2000, days: days(7, { spend: 2000, paid: 16 }) };

  it("raises a winner by 10%", () => {
    const { decisions } = decide({ units: [winner], limits, funds: { available: 50000, avgDailySpend: 2000 }, now });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload).toMatchObject({ from: 2000, to: 2200 });
  });

  it("never scales when funds cover under 5 days", () => {
    const { decisions } = decide({ units: [winner], limits, funds: { available: 6000, avgDailySpend: 2000 }, now });
    expect(decisions).toHaveLength(0);
  });

  it("respects the weekly increase cap", () => {
    const { decisions } = decide({ units: [winner], limits, funds: { available: 50000, avgDailySpend: 2000 }, increasedThisWeek: 400, now });
    // week base 1,600 → 25% = 400 already used
    expect(decisions).toHaveLength(0);
  });

  it("waits 7 days between budget steps", () => {
    const u = { ...winner, lastBudgetChangeAt: new Date(now.getTime() - 4 * 86400000) };
    const { decisions } = decide({ units: [u], limits, funds: { available: 50000, avgDailySpend: 2000 }, now });
    expect(decisions).toHaveLength(0);
  });

  it("lowers a losing unit by 15% and leaves the winner's budget to its own rule", () => {
    const loser = { id: "l", name: "TE", level: "campaign", dailyBudget: 2000, days: days(7, { spend: 2000, paid: 3 }) };
    const { decisions } = decide({ units: [loser], limits, funds: { available: 50000, avgDailySpend: 2000 }, now });
    expect(decisions[0].payload).toMatchObject({ from: 2000, to: 1700 });
  });
});

describe("emergencies", () => {
  it("warns when funds run out within 3 days", () => {
    const out = emergencies({ funds: { available: 4288, avgDailySpend: 8000 } });
    expect(out[0].title).toMatch(/stop today/);
  });
});
