import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { getAstrologyDelay } from "../src/utils/astrology/astroHelper.js";

const at = (hour, minute = 0) =>
  DateTime.fromObject({ year: 2026, month: 3, day: 10, hour, minute }, { zone: "Asia/Kolkata" });

const deliveredAt = (now) => now.plus({ minutes: parseInt(getAstrologyDelay(now), 10) });

describe("getAstrologyDelay", () => {
  it("delivers 2–3 hours later during working hours", () => {
    for (let i = 0; i < 50; i++) {
      const minutes = parseInt(getAstrologyDelay(at(11)), 10);
      expect(minutes).toBeGreaterThanOrEqual(120);
      expect(minutes).toBeLessThanOrEqual(180);
    }
  });

  it.each([
    ["late evening", at(19, 30), 11],
    ["night", at(23), 11],
    ["early morning", at(3), 10],
    ["pre-dawn", at(5), 10],
  ])("moves a %s request to 9–11 AM the next working morning", (_, now, day) => {
    for (let i = 0; i < 50; i++) {
      const t = deliveredAt(now);
      expect(t.day).toBe(day);
      expect(t.hour * 60 + t.minute).toBeGreaterThanOrEqual(9 * 60);
      expect(t.hour * 60 + t.minute).toBeLessThanOrEqual(11 * 60 + 1);
    }
  });
});
