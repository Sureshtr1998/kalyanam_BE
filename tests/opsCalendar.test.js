import { describe, expect, it } from "vitest";
import { calendarNotes, elongation, hinduCalendar, newMoons, sunTimes, tithiAt } from "../src/ops/hinduCalendar.js";
import { cleanPath, pickWinners, withPath } from "../src/ops/adsCreative.js";

const IST = 5.5 * 3600000;
const ist = (s) => Date.parse(`${s}:00Z`) - IST;
const on = (events, name) => events.filter((e) => e.name === name).map((e) => e.start);

describe("Hindu calendar: astronomy", () => {
  it("finds the January 2000 new moon (Meeus: 6 Jan 18:14 UT) within 5 minutes", () => {
    const [nm] = newMoons(Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 10));
    expect(Math.abs(nm - Date.UTC(2000, 0, 6, 18, 14))).toBeLessThan(5 * 60000);
  });

  it("matches published tithi times (Chaitra Shukla Pratipada 2026: 06:52 on 19 Mar to 04:52 on 20 Mar)", () => {
    expect(tithiAt(ist("2026-03-19T06:45"))).toBe(30);
    expect(tithiAt(ist("2026-03-19T07:05"))).toBe(1);
    expect(tithiAt(ist("2026-03-20T04:45"))).toBe(1);
    expect(tithiAt(ist("2026-03-20T05:05"))).toBe(2);
  });

  it("gives Bengaluru sunrise to within a few minutes", () => {
    const t = new Date(sunTimes("2026-11-27").sunrise + IST).toISOString().slice(11, 16);
    expect(t >= "06:20" && t <= "06:28").toBe(true);
  });

  it("puts Venus's superior conjunction near 6 Jan 2026 and Jupiter's near 29 Jul 2026", () => {
    const minDay = (planet, from, days) => {
      let best = null;
      for (let i = 0; i < days; i++) {
        const t = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10) + i);
        const e = elongation(planet, t);
        if (!best || e < best.e) best = { e, day: new Date(t).toISOString().slice(0, 10) };
      }
      return best.day;
    };
    const near = (a, b, d) => Math.abs(Date.parse(a) - Date.parse(b)) <= d * 86400000;
    expect(near(minDay("venus", "2025-12-15", 45), "2026-01-06", 3)).toBe(true);
    expect(near(minDay("jupiter", "2026-07-01", 60), "2026-07-29", 3)).toBe(true);
  });
});

describe("Hindu calendar: festivals and wedding periods (2026, as published)", () => {
  const ev = hinduCalendar("2026-01-01", "2026-12-31");

  it.each([
    ["Makara Sankranti (Pongal in Tamil Nadu)", "2026-01-14"],
    ["Maha Shivaratri", "2026-02-15"],
    ["Holi", "2026-03-04"],
    ["Ugadi (new year)", "2026-03-19"],
    ["Sri Rama Navami", "2026-03-26"],
    ["Tamil New Year (Puthandu)", "2026-04-14"],
    ["Akshaya Tritiya", "2026-04-19"],
    ["Raksha Bandhan", "2026-08-28"],
    ["Krishna Janmashtami", "2026-09-04"],
    ["Ganesh Chaturthi", "2026-09-14"],
    ["Vijayadashami (Dasara)", "2026-10-20"],
    ["Deepavali (Lakshmi Puja)", "2026-11-08"],
  ])("%s on %s", (name, date) => {
    expect(on(ev, name)).toContain(date);
  });

  it("marks the adhika month, Ashadha, Pitru Paksha and Dhanurmasa", () => {
    const span = (name) => ev.filter((e) => e.name === name).map((e) => [e.start, e.end]);
    expect(span("Adhika Jyeshtha masa")[0][0]).toMatch(/^2026-05-1[6-8]$/);
    expect(ev.find((e) => e.name === "Ashadha masa").start).toMatch(/^2026-07-1[3-5]$/);
    expect(ev.find((e) => e.name.startsWith("Pitru Paksha")).kind).toBe("no_weddings");
    const dhanur = ev.find((e) => e.name.startsWith("Dhanurmasa") && e.start.startsWith("2026"));
    expect(dhanur.start).toBe("2026-12-16");
    expect(dhanur.regions).not.toContain("Hindi");
  });

  it("writes prompt notes for one language only", () => {
    const now = Date.parse("2026-12-10T06:00:00Z");
    const tamil = calendarNotes({ days: 21, language: "Tamil", now });
    expect(tamil).toMatch(/Dhanurmasa/);
    expect(tamil).not.toMatch(/Kharmas/);
    expect(calendarNotes({ days: 21, language: "Hindi", now })).toMatch(/Kharmas/);
    expect(tamil).toMatch(/find the right match now/);
  });
});

describe("ad links and winning ad sets", () => {
  it("keeps only safe site paths", () => {
    expect(cleanPath("/pricing")).toBe("/pricing");
    expect(cleanPath("/pricing/")).toBe("/pricing");
    expect(cleanPath("")).toBeNull();
    expect(cleanPath("https://evil.example")).toBeNull();
    expect(cleanPath("//evil.example")).toBeNull();
    expect(cleanPath("/a?b=c")).toBeNull();
  });

  it("points the copied link at the page in the ad's language and keeps the tracking", () => {
    expect(withPath("https://www.seetharamakalyana.in/kn?utm_source=meta&utm_content=x", "Kannada", "/pricing")).toBe(
      "https://www.seetharamakalyana.in/kn/pricing?utm_source=meta&utm_content=x"
    );
    expect(withPath("https://www.seetharamakalyana.in/?utm_source=meta", "English", "/pricing")).toBe("https://www.seetharamakalyana.in/pricing?utm_source=meta");
    expect(withPath("https://www.seetharamakalyana.in/te", "Telugu", "")).toBe("https://www.seetharamakalyana.in/te");
  });

  it("protects the cheapest ad set with enough members, only where the campaign has another", () => {
    const rows = [
      { id: "a1", campaignId: "A", name: "Kannada | Bengaluru", status: "ACTIVE", spend: 3000, paid: 15 },
      { id: "a2", campaignId: "A", name: "Kannada | Mysuru", status: "ACTIVE", spend: 3000, paid: 10 },
      { id: "a3", campaignId: "A", name: "Kannada | old", status: "PAUSED", spend: 100, paid: 5 },
      { id: "b1", campaignId: "B", name: "Telugu | Hyderabad", status: "ACTIVE", spend: 3000, paid: 20 },
      { id: "c1", campaignId: "C", name: "Tamil | Chennai", status: "ACTIVE", spend: 3000, paid: 5 },
      { id: "c2", campaignId: "C", name: "Tamil | Coimbatore", status: "ACTIVE", spend: 3000, paid: 4 },
    ];
    const w = pickWinners(rows);
    expect([...w.keys()]).toEqual(["a1"]);
    expect(Math.round(w.get("a1").cpp)).toBe(200);
  });
});
