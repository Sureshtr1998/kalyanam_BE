import { describe, expect, it } from "vitest";
import { buildLibrary, ideaOf, pickIdeas, verdictFor } from "../src/ops/adsIdeas.js";

describe("tagging ads with ideas", () => {
  it("reads the idea from the owner's ad names", () => {
    expect(ideaOf("KN-09 Parents Why 351")).toBe("why351");
    expect(ideaOf("HI-07 Parents Communities 2")).toBe("community");
    expect(ideaOf("TE-S1 Parents Safety")).toBe("daughters");
    expect(ideaOf("KN-01 Parents Brand")).toBe("brand");
    expect(ideaOf("TA-06 Brand 9x16")).toBe("brand");
    expect(ideaOf("RANDOM-1")).toBe("other");
  });

  it("prefers the agent's own record for its ads", () => {
    expect(ideaOf("KN-OPS kn_ops_parents_1201a ಯಾಕೆಂದರೆ", "horoscope")).toBe("horoscope");
  });
});

// Last month's shape: Kannada parents love "community", Telugu parents "why351"; nobody tried horoscope.
const ads = [
  { id: "a1", name: "KN-07 Parents Communities 2", campaignName: "SRK | Kannada", adsetName: "Kannada | Karnataka | Parents 45-65", spend: 4000, paid: 22 },
  { id: "a2", name: "KN-09 Parents Why 351", campaignName: "SRK | Kannada", adsetName: "Kannada | Karnataka | Parents 45-65", spend: 4000, paid: 15 },
  { id: "a3", name: "TE-09 Parents Why 351", campaignName: "SRK | Telugu", adsetName: "Telugu | AP + Telangana | Parents 45-65", spend: 3000, paid: 14 },
  { id: "a4", name: "TE-S1 Parents Safety", campaignName: "SRK | Telugu", adsetName: "Telugu | AP + Telangana | Parents 45-65", spend: 4000, paid: 4 },
  { id: "a5", name: "TA-07 Parents Communities 2", campaignName: "SRK | Tamil", adsetName: "Tamil | TN | Parents 45-65", spend: 900, paid: 2 },
  { id: "a6", name: "KN-05 Young Communities 2", campaignName: "SRK | Kannada", adsetName: "Kannada | Karnataka + 4 cities | Young 24-34", spend: 2400, paid: 11 },
];

describe("idea library", () => {
  it("adds up ads by idea, language and audience", () => {
    const lib = buildLibrary({ ads });
    const kn = lib.find((r) => r.idea === "community" && r.language === "Kannada" && r.audience === "parents");
    expect(kn).toMatchObject({ spend: 4000, paid: 22 });
    expect(kn.cpp).toBeCloseTo(181.8, 0);
    expect(lib.find((r) => r.idea === "community" && r.audience === "young")).toMatchObject({ language: "Kannada", paid: 11 });
  });
});

describe("picking ideas for an ad set", () => {
  const library = buildLibrary({ ads });

  it("repeats the best proven idea here and tests the best idea from other languages", () => {
    const { proven, tests } = pickIdeas({ library, language: "Telugu", audience: "parents" });
    // Telugu parents: why351 ₹214 beats safety ₹1,000.
    expect(proven).toMatchObject({ idea: "why351", where: "here" });
    // Community did well for Kannada parents and hasn't been tried in Telugu.
    expect(tests[0]).toMatchObject({ idea: "community" });
    expect(tests[0].why).toMatch(/other languages/);
    expect(tests.map((t) => t.idea)).not.toContain("daughters");
  });

  it("uses an idea proven in other languages when none is proven here yet", () => {
    const { proven, tests } = pickIdeas({ library, language: "Tamil", audience: "parents" });
    expect(proven).toMatchObject({ idea: "community", where: "other languages" });
    // Tamil's community ad spent under ₹1,500, but community is the proven pick, so the test is the next idea.
    expect(tests[0].idea).toBe("why351");
  });

  it("offers untried ideas when there is no data at all", () => {
    const { proven, tests } = pickIdeas({ library: [], language: "Hindi", audience: "young" });
    expect(proven).toBeNull();
    expect(tests).toHaveLength(3);
    expect(tests[0].why).toBe("not tried anywhere yet");
  });
});

describe("verdict for a new ad", () => {
  it("waits 7 days and enough spend", () => {
    expect(verdictFor({ ad: { spend: 3000, paid: 15 }, adset: { spend: 9000, paid: 30 }, ageDays: 5 })).toBeNull();
    expect(verdictFor({ ad: { spend: 900, paid: 3 }, adset: { spend: 9000, paid: 30 }, ageDays: 9 })).toBeNull();
  });

  it("wins at ≤ 90% of its ad set's cost per member and loses at ≥ 130%", () => {
    expect(verdictFor({ ad: { spend: 2000, paid: 8 }, adset: { spend: 9000, paid: 30 }, ageDays: 8 }).verdict).toBe("win");
    // ₹400 vs ₹300 = 1.33×
    expect(verdictFor({ ad: { spend: 2000, paid: 5 }, adset: { spend: 9000, paid: 30 }, ageDays: 8 }).verdict).toBe("lose");
    expect(verdictFor({ ad: { spend: 2000, paid: 7 }, adset: { spend: 9000, paid: 30 }, ageDays: 8 }).verdict).toBe("even");
    expect(verdictFor({ ad: { spend: 2000, paid: 0 }, adset: { spend: 9000, paid: 30 }, ageDays: 8 }).verdict).toBe("lose");
  });

  it("calls it unclear when Meta barely ran it for 14 days", () => {
    expect(verdictFor({ ad: { spend: 300, paid: 0 }, adset: { spend: 9000, paid: 30 }, ageDays: 15 }).verdict).toBe("unclear");
  });
});
