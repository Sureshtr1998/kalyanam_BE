import { describe, expect, it } from "vitest";
import { adDecisions, batchGate, brakes, calibration, classify, decide, emergencies, languageCalibration, languageCoverage, languageOf, tagLanguage, windowStats } from "../src/ops/adsEngine.js";

const limits = {
  maxDailySpend: 10000,
  maxWeeklyIncreasePct: 25,
  stepUpPct: 10,
  stepDownPct: 15,
  scaleRoas: 1.5,
  netRevenuePerMember: 285,
  losingCostPerMember: 420,
};
const now = new Date("2026-12-20T06:00:00Z");
const DAY = 86400000;
/** n days ending yesterday, oldest first. */
const days = (n, row) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(now.getTime() - (n - i) * DAY).toISOString().slice(0, 10),
    impressions: 10000,
    clicks: 400,
    frequency7: 1.8,
    ...row,
  }));
/** A unit whose last 7 days are `recent` and the 7 before are `older`. */
const unit = (id, budget, older, recent, extra = {}) => ({
  id,
  name: id,
  level: "campaign",
  dailyBudget: budget,
  days: [...days(14, older).slice(0, 7), ...days(7, recent)],
  ...extra,
});

describe("windows and helpers", () => {
  it("adds up a window and computes link click rate", () => {
    const w = windowStats(days(7, { spend: 1000, paid: 4 }));
    expect(w).toMatchObject({ spend: 7000, paid: 28, cpp: 250, ctr: 4 });
  });

  it("corrects Meta's member count by our own joins, within 1–1.3", () => {
    expect(calibration({ metaPaid: 186, realJoins: 226 })).toBeCloseTo(1.215, 2);
    expect(calibration({ metaPaid: 100, realJoins: 200 })).toBe(1.3);
    expect(calibration({ metaPaid: 100, realJoins: 80 })).toBe(1);
    // Too few members to trust.
    expect(calibration({ metaPaid: 10, realJoins: 20 })).toBe(1);
  });

  it("reads the language from a campaign name", () => {
    expect(languageOf("SRK | Kannada")).toBe("Kannada");
    expect(languageOf("SRK | Women safety")).toBe("English");
  });
});

describe("classify", () => {
  it("leaves a recently changed unit alone", () => {
    const r = classify({ days: days(14, { spend: 1000, paid: 8 }), lastBudgetChangeAt: new Date(now.getTime() - DAY) }, limits, now);
    expect(r.state).toBe("learning");
  });

  it("doesn't freeze a language's budget for new or paused ads (only those ad sets re-learn)", () => {
    const r = classify({ days: days(14, { spend: 1000, paid: 8 }), lastStructureChangeAt: new Date(now.getTime() - 4 * DAY) }, limits, now);
    expect(r.state).toBe("winning");
    expect(r.notes.join(" ")).toMatch(/re-learning, so costs may wobble/);
  });

  it("doesn't judge on too little spend", () => {
    const r = classify({ days: days(14, { spend: 150, paid: 0 }) }, limits, now);
    expect(r.state).toBe("low_data");
  });

  it("calls ₹125 per member winning", () => {
    const r = classify({ days: days(14, { spend: 1000, paid: 8 }) }, limits, now);
    expect(r.state).toBe("winning");
  });

  it("does not scale Kannada at ₹236 on Meta (₹194 real, 1.47x)", () => {
    const r = classify({ days: days(14, { spend: 1686, paid: 50 / 7 }) }, limits, now, { calib: 1.215 });
    expect(r.state).toBe("healthy");
    expect(r.metrics.roas7).toBeCloseTo(1.47, 1);
  });

  it("does not call Tamil losing on a bad 3 days when the week is fine (the old rule did)", () => {
    // ₹320/member over 7 days, ₹454 over the last 3.
    const d = [...days(14, { spend: 1640, paid: 5.4 }).slice(0, 11), ...days(3, { spend: 1640, paid: 3.6 })];
    const r = classify({ days: d }, limits, now, { calib: 1.2 });
    expect(r.state).toBe("healthy");
  });

  it("calls losing when 7 and 14 days both cost too much", () => {
    const r = classify({ days: days(14, { spend: 2000, paid: 3 }) }, limits, now);
    expect(r.state).toBe("losing");
  });

  it("flags tired on high frequency, independent of the state", () => {
    const r = classify({ days: days(14, { spend: 1000, paid: 8, frequency7: 2.7 }) }, limits, now);
    expect(r.flags.tired).toBe(true);
    expect(r.state).toBe("winning");
  });

  it("flags tired when click rate drops 20% and cost rises 15% week on week", () => {
    const u = unit("t", 1500, { spend: 1500, paid: 6, clicks: 500 }, { spend: 1500, paid: 5, clicks: 380 });
    expect(classify(u, limits, now).flags.tired).toBe(true);
  });

  it("ignores a 3-day click-rate wobble (the old rule's false alarm)", () => {
    const d = days(14, { spend: 1500, paid: 6, clicks: 400 });
    d[11].clicks = 420;
    d[12].clicks = 400;
    d[13].clicks = 380;
    expect(classify({ days: d }, limits, now).flags.tired).toBeUndefined();
  });

  it("holds a winner whose return slipped in the last 3 days", () => {
    const d = [...days(14, { spend: 1000, paid: 10 }).slice(0, 11), ...days(3, { spend: 1000, paid: 4 })];
    expect(classify({ days: d }, limits, now).state).toBe("healthy");
  });
});

describe("decide: moving money between languages", () => {
  // Last week's real numbers (Meta): KN ₹236, TE ₹402, HI ₹380, TA ₹320 per member.
  const live = () => [
    unit("KN", 1700, { spend: 1600, paid: 7 }, { spend: 1686, paid: 50 / 7 }),
    unit("TE", 2100, { spend: 2000, paid: 5 }, { spend: 2181, paid: 38 / 7 }),
    unit("HI", 2500, { spend: 2400, paid: 6.5 }, { spend: 2495, paid: 46 / 7 }),
    unit("TA", 1700, { spend: 1600, paid: 5.5 }, { spend: 1644, paid: 36 / 7 }),
  ];

  it("moves ₹300/day from Telugu to Kannada and leaves the rest alone", () => {
    const { decisions } = decide({ units: live(), limits, settings: { rebalance: true }, calib: 1.215, now });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ type: "ads.rebalance" });
    expect(decisions[0].payload.moves).toEqual([
      expect.objectContaining({ entityId: "TE", from: 2100, to: 1800 }),
      expect.objectContaining({ entityId: "KN", from: 1700, to: 2000 }),
    ]);
  });

  it("keeps the total daily budget the same", () => {
    const { decisions } = decide({ units: live(), limits, settings: { rebalance: true }, now });
    const m = decisions[0].payload.moves;
    expect(m[0].to + m[1].to).toBe(m[0].from + m[1].from);
  });

  it("doesn't move when our own joins say the donor is actually cheaper", () => {
    const units = live();
    // Telugu brought many real joins, Kannada few.
    for (const r of units[1].days) r.real = 12;
    for (const r of units[0].days) r.real = 3;
    const { decisions, evaluated } = decide({ units, limits, settings: { rebalance: true }, now });
    expect(decisions).toHaveLength(0);
    expect(evaluated.find((e) => e.unit.id === "TE").notes.join(" ")).toMatch(/don't confirm/);
  });

  it("doesn't give more to a language that can't spend what it has", () => {
    const units = live();
    units[0].dailyBudget = 2500; // spends ₹1,686 of ₹2,500
    const { decisions } = decide({ units, limits, settings: { rebalance: true }, now });
    expect(decisions.filter((d) => d.type === "ads.rebalance")).toHaveLength(0);
  });

  it("can be switched off", () => {
    const { decisions } = decide({ units: live(), limits, settings: { rebalance: false }, now });
    expect(decisions).toHaveLength(0);
  });

  it("never takes a language below ₹500/day", () => {
    const units = live();
    units[1].dailyBudget = 550;
    const { decisions } = decide({ units, limits, settings: { rebalance: true }, now });
    expect(decisions.filter((d) => d.type === "ads.rebalance")).toHaveLength(0);
  });
});

describe("decide: cuts and raises", () => {
  const winner = () => unit("w", 2000, { spend: 2000, paid: 16 }, { spend: 2000, paid: 16 });

  it("raises a winner (+15% when twice the target)", () => {
    const { decisions } = decide({ units: [winner()], limits, settings: {}, now });
    expect(decisions[0].payload).toMatchObject({ from: 2000, to: 2300 });
  });

  it("raises a normal winner by the configured 10%", () => {
    const u = unit("w", 2000, { spend: 2000, paid: 11 }, { spend: 2000, paid: 11 });
    const { decisions } = decide({ units: [u], limits, settings: {}, now });
    expect(decisions[0].payload).toMatchObject({ from: 2000, to: 2200 });
  });

  it("scales on results alone: the prepaid balance is never a reason to hold", () => {
    // Funds passed in by an old caller are ignored.
    const { decisions } = decide({ units: [winner()], limits, settings: {}, funds: { available: 100, avgDailySpend: 9000 }, now });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].payload).toMatchObject({ from: 2000, to: 2300 });
  });

  it("respects the weekly increase cap", () => {
    const { decisions } = decide({ units: [winner()], limits, settings: {}, increasedThisWeek: 400, now });
    expect(decisions).toHaveLength(0);
  });

  it("Monday's step goes live Tuesday; Thursday may plan the next (live Friday, 3 days later), not sooner", () => {
    const tooSoon = { ...winner(), lastBudgetChangeAt: new Date(now.getTime() - 1 * DAY) };
    expect(decide({ units: [tooSoon], limits, settings: {}, now, mode: "midweek" }).decisions).toHaveLength(0);
    const thursday = { ...winner(), lastBudgetChangeAt: new Date(now.getTime() - 2 * DAY) };
    expect(decide({ units: [thursday], limits, settings: {}, now, mode: "midweek" }).decisions[0]).toMatchObject({ type: "ads.budget", payload: { from: 2000 } });
  });

  it("keeps one language's growth within +25% a week (moves in and raises together)", () => {
    const grown = { ...winner(), days: winner().days.map((d, i, all) => ({ ...d, dailyBudget: i === all.length - 7 ? 1700 : 2000 })) };
    const { decisions, evaluated } = decide({ units: [grown], limits, settings: {}, now });
    expect(decisions).toHaveLength(0);
    expect(evaluated[0].notes.join(" ")).toMatch(/Already up 18% this week/);
  });

  it("doesn't raise a language braked in the last 7 days (no see-saw)", () => {
    const braked = { ...winner(), lastBudgetChangeAt: new Date(now.getTime() - 4 * DAY), lastBrakeAt: new Date(now.getTime() - 4 * DAY) };
    const { decisions, evaluated } = decide({ units: [braked], limits, settings: {}, now });
    expect(decisions).toHaveLength(0);
    expect(evaluated[0].notes.join(" ")).toMatch(/Braked in the last 7 days/);
  });

  it("only raises on Thursdays: no moves or cuts mid-week", () => {
    const cheap = unit("cheap", 2000, { spend: 2000, paid: 16 }, { spend: 2000, paid: 16 });
    const dear = unit("dear", 2000, { spend: 2000, paid: 3 }, { spend: 2000, paid: 3 });
    const { decisions } = decide({ units: [cheap, dear], limits, settings: {}, now, mode: "midweek" });
    expect(decisions.map((d) => d.type)).toEqual(["ads.budget"]);
    expect(decisions[0].payload.to).toBeGreaterThan(2000);
  });

  it("doesn't raise a tired audience until fresh ads have gone live", () => {
    const tired = unit("w", 2000, { spend: 2000, paid: 16 }, { spend: 2000, paid: 16, frequency7: 2.7 });
    const none = decide({ units: [tired], limits, settings: {}, now });
    expect(none.decisions).toHaveLength(0);
    expect(none.evaluated[0].notes.join(" ")).toMatch(/scales after fresh ads go live/);
    const fresh = { ...tired, lastLaunchAt: new Date(now.getTime() - 2 * DAY) };
    expect(decide({ units: [fresh], limits, settings: {}, now }).decisions).toHaveLength(1);
  });

  it("cuts a losing unit by 15% when no cheaper unit can take the money", () => {
    const loser = unit("l", 2000, { spend: 2000, paid: 3 }, { spend: 2000, paid: 3 });
    const { decisions } = decide({ units: [loser], limits, settings: {}, now });
    expect(decisions[0]).toMatchObject({ type: "ads.budget", payload: { from: 2000, to: 1700 } });
  });

  it("moves a loser's money to a cheap unit instead of cutting it", () => {
    const loser = unit("l", 2000, { spend: 2000, paid: 3 }, { spend: 2000, paid: 3 });
    const cheap = unit("c", 2000, { spend: 2000, paid: 9 }, { spend: 2000, paid: 9 });
    const { decisions } = decide({ units: [loser, cheap], limits, settings: { rebalance: true }, now });
    expect(decisions.map((d) => d.type)).toEqual(["ads.rebalance"]);
  });
});

describe("adDecisions", () => {
  const ad = (id, spend14, paid14, extra = {}) => ({ id, name: id, adsetId: "s1", campaignId: "TE", createdAt: new Date(now.getTime() - 20 * DAY), spend14, paid14, ...extra });
  const ref = new Map([["TE", 400]]);

  it("pauses an ad costing ≥ 1.8× its campaign (TE-04: ₹1,807 for 2)", () => {
    const { pauses } = adDecisions({ ads: [ad("TE-04", 1807, 2), ad("TE-07", 981, 5), ad("TE-01", 6000, 18)], campaignCpp14: ref, now });
    expect(pauses.map((p) => p.adId)).toEqual(["TE-04"]);
  });

  it("keeps ads that are expensive but not clearly bad (TE-09: ₹1,851 for 3)", () => {
    const { pauses } = adDecisions({ ads: [ad("TE-09", 1851, 3), ad("TE-07", 981, 5), ad("TE-01", 6000, 18)], campaignCpp14: ref, now });
    expect(pauses).toHaveLength(0);
  });

  it("gives new ads 7 days and enough spend", () => {
    const young = ad("new", 2000, 0, { createdAt: new Date(now.getTime() - 3 * DAY) });
    const small = ad("small", 600, 0);
    const { pauses } = adDecisions({ ads: [young, small, ad("a", 3000, 9), ad("b", 3000, 9)], campaignCpp14: ref, now });
    expect(pauses).toHaveLength(0);
  });

  it("never leaves an ad set with fewer than 2 active ads, and reports it as thin", () => {
    const { pauses, thin } = adDecisions({ ads: [ad("bad1", 3000, 0), ad("bad2", 3000, 1), ad("ok", 3000, 9)], campaignCpp14: ref, now });
    expect(pauses).toHaveLength(1);
    expect(pauses[0].adId).toBe("bad1");
    expect(thin).toEqual([{ adsetId: "s1", campaignId: "TE", active: 2 }]);
  });
});

describe("emergencies", () => {
  it("never alerts about the prepaid balance (the owner keeps it funded)", () => {
    expect(emergencies({ funds: { available: 100, avgDailySpend: 9000 }, settings: { autoTopUp: false } })).toEqual([]);
  });

  it("raises disapproved ads, account problems and stalled delivery as urgent", () => {
    const out = emergencies({
      accountStatus: 3,
      adIssues: [{ name: "KN-09", effective_status: "DISAPPROVED", issue: "Personal attributes" }, { name: "TE-01", effective_status: "WITH_ISSUES" }],
      budgetTotal: 8000,
      yesterdaySpend: 900,
    });
    const types = out.map((o) => [o.type, o.priority]);
    expect(types).toEqual(
      expect.arrayContaining([
        ["ads.account_status", "urgent"],
        ["ads.disapproved", "urgent"],
        ["ads.issues", "normal"],
        ["ads.delivery_stalled", "urgent"],
      ])
    );
    expect(out.find((o) => o.type === "ads.disapproved").reason).toMatch(/KN-09: Personal attributes/);
  });
});

describe("batchGate", () => {
  it("is closed before the owner's hands-off date", () => {
    expect(batchGate({ settings: { handsOffUntil: "2026-12-25" }, now }).open).toBe(false);
  });

  it("is closed within 14 days of the last batch and open after", () => {
    expect(batchGate({ settings: {}, lastBatchAt: new Date(now.getTime() - 10 * DAY), now }).open).toBe(false);
    expect(batchGate({ settings: {}, lastBatchAt: new Date(now.getTime() - 14 * DAY), now }).open).toBe(true);
    expect(batchGate({ settings: {}, lastBatchAt: null, now }).open).toBe(true);
  });
});

describe("all four languages, always", () => {
  const camp = (id, name, status = "ACTIVE", dailyBudget = 1700) => ({ id, name, status, dailyBudget });
  const campaigns = [camp("kn", "SRK | Kannada"), camp("te", "SRK | Telugu"), camp("ta", "SRK | Tamil"), camp("hi", "SRK | Hindi")];
  const ads = campaigns.map((c) => ({ campaign_id: c.id, effective_status: "ACTIVE" }));

  it("is quiet when every language has a campaign, budget and running ads", () => {
    expect(languageCoverage({ campaigns, adsets: [], ads })).toEqual([]);
  });

  it("flags a language that is paused, starved of budget or has no ads", () => {
    const gaps = languageCoverage({
      campaigns: [camp("kn", "SRK | Kannada"), camp("te", "SRK | Telugu", "PAUSED"), camp("ta", "SRK | Tamil", "ACTIVE", 200), camp("hi", "SRK | Hindi")],
      adsets: [],
      ads: ads.filter((a) => a.campaign_id !== "hi"),
    });
    expect(gaps.map((g) => g.language)).toEqual(["Telugu", "Tamil", "Hindi"]);
    const out = emergencies({ funds: { available: null, avgDailySpend: 0 }, uncovered: gaps });
    expect(out[0]).toMatchObject({ type: "ads.language_gap", priority: "urgent" });
    expect(out[0].title).toBe("Ads aren't running in Telugu, Tamil, Hindi");
  });

  it("never cuts a language below ₹500/day", () => {
    const at550 = decide({ units: [unit("l", 550, { spend: 2000, paid: 2 }, { spend: 2000, paid: 2 })], limits, settings: {}, now });
    expect(at550.decisions[0].payload).toMatchObject({ from: 550, to: 500 });
    const at500 = decide({ units: [unit("l", 500, { spend: 2000, paid: 2 }, { spend: 2000, paid: 2 })], limits, settings: {}, now });
    expect(at500.decisions).toHaveLength(0);
  });
});

describe("ramp-up languages (owner's rule, 28 Nov 2026)", () => {
  it("never gives budget away and is never cut, and is judged on its own trend", () => {
    const kn = unit("kn", 1700, { spend: 1700, paid: 8 }, { spend: 1700, paid: 8 });
    const hi = unit("hi", 2500, { spend: 2500, paid: 3 }, { spend: 2500, paid: 2 }, { rampUp: true });
    const { decisions, evaluated } = decide({ units: [kn, hi], limits, settings: {}, now });
    expect(decisions.filter((d) => d.unitId === "hi")).toHaveLength(0);
    expect(decisions.some((d) => d.type === "ads.rebalance")).toBe(false);
    const e = evaluated.find((x) => x.unit.id === "hi");
    expect(e.state).toBe("ramping");
    expect(e.notes.join(" ")).toMatch(/Ramp-up language: .* per member this week vs/);
  });

  it("can still receive money and be raised when it wins", () => {
    const hi = unit("hi", 2000, { spend: 2000, paid: 16 }, { spend: 2000, paid: 16 }, { rampUp: true });
    expect(decide({ units: [hi], limits, settings: {}, now }).decisions[0]).toMatchObject({ type: "ads.budget" });
  });
});

describe("the mid-week brake", () => {
  const steady = { spend: 1000, paid: 4 };
  it("steps a language down when its last 3 days cost twice its usual, with ₹3,000+ spent", () => {
    const u = { ...unit("te", 2100, steady, steady), days: [...days(11, steady), ...days(3, { spend: 1200, paid: 1 })] };
    const { decisions, alerts } = brakes({ units: [u], limits: { ...limits, stepDownPct: 15 }, now });
    expect(alerts).toHaveLength(0);
    expect(decisions[0]).toMatchObject({ type: "ads.budget", payload: { from: 2100, to: 1790, brake: true } });
    expect(decisions[0].title).toMatch(/^Brake: lower te/);
  });

  it("doesn't brake in the 5 days after new or paused ads (normal wobble while Meta learns them)", () => {
    const u = { ...unit("te", 2100, steady, steady), days: [...days(11, steady), ...days(3, { spend: 1200, paid: 1 })], lastStructureChangeAt: new Date(now.getTime() - 2 * DAY) };
    expect(brakes({ units: [u], limits: { ...limits, stepDownPct: 15 }, now }).decisions).toHaveLength(0);
  });

  it("only alerts for a ramp-up language, and leaves a normal week alone", () => {
    const bad = { ...unit("hi", 2500, steady, steady, { rampUp: true }), days: [...days(11, steady), ...days(3, { spend: 1200, paid: 0 })] };
    const ok = unit("kn", 1700, steady, steady);
    const r = brakes({ units: [bad, ok], limits: { ...limits, stepDownPct: 15 }, now });
    expect(r.decisions).toHaveLength(0);
    expect(r.alerts.map((a) => a.unit.id)).toEqual(["hi"]);
  });
});

describe("per-language real joins from ad tags", () => {
  it("reads the language from each ad's link tag", () => {
    expect(tagLanguage({ utmContent: "kn_why351" })).toBe("Kannada");
    expect(tagLanguage({ utmContent: "tamil_brand" })).toBe("Tamil");
    expect(tagLanguage({ utmContent: "te_ops_parents_1126a" })).toBe("Telugu");
    expect(tagLanguage({ utmContent: "hi_communities_v2_young" })).toBe("Hindi");
    expect(tagLanguage({ utmCampaign: "srk_sales_nov26" })).toBe("Kannada");
    expect(tagLanguage({ utmCampaign: "srk_sales_te_ta" })).toBeNull();
  });

  it("shares the real members out by tagged sign-ups (Meta said Hindi 44 / Telugu 38; tags say 32 / 58)", () => {
    const c = languageCalibration({ metaPaid: { Hindi: 44, Telugu: 38 }, tagged: { Hindi: 32, Telugu: 58 }, accountCalib: 1.2 });
    expect(c.Telugu).toBeGreaterThan(1.5);
    expect(c.Hindi).toBeLessThan(0.8);
    expect(languageCalibration({ metaPaid: { Hindi: 44 }, tagged: { Hindi: 10 }, accountCalib: 1.2 })).toBeNull();
  });

  it("compares languages per real member once every language has tagged joins", () => {
    // Meta says te is dearer, but its tagged joins say it's the cheaper one: no move away from it.
    const kn = unit("kn", 2000, { spend: 2000, paid: 8 }, { spend: 2000, paid: 8 }, { calib: 1, calibSource: "tagged" });
    const te = unit("te", 2000, { spend: 2000, paid: 5 }, { spend: 2000, paid: 5 }, { calib: 2, calibSource: "tagged" });
    const { decisions, average } = decide({ units: [kn, te], limits, settings: {}, now });
    expect(average.real).toBe(true);
    expect(decisions.some((d) => d.type === "ads.rebalance" && d.payload.moves[0].entityId === "te")).toBe(false);
  });
});
