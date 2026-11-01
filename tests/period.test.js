import { describe, expect, it } from "vitest";
import { periodRange } from "../src/routes/auth/manage.js";
import { api, createBroker, createUser, tokenFor } from "./helpers.js";

describe("periodRange (IST calendar periods)", () => {
  // Wed 2026-11-04 01:00 IST = Tue 2026-11-03 19:30 UTC
  const now = Date.parse("2026-11-03T19:30:00Z");

  it("starts today at IST midnight, not UTC midnight", () => {
    expect(periodRange("today", now).from.toISOString()).toBe("2026-11-03T18:30:00.000Z");
  });

  it("covers the whole previous IST day for yesterday", () => {
    const { from, to } = periodRange("yesterday", now);
    expect(from.toISOString()).toBe("2026-11-02T18:30:00.000Z");
    expect(to.toISOString()).toBe("2026-11-03T18:30:00.000Z");
  });

  it("starts the week on Monday and the month on the 1st", () => {
    expect(periodRange("week", now).from.toISOString()).toBe("2026-11-01T18:30:00.000Z");
    expect(periodRange("month", now).from.toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });

  it("rejects unknown periods", () => {
    expect(periodRange("decade", now)).toBeNull();
  });
});

describe("GET /manage/period", () => {
  it("counts today's sign-ups and net earnings including partner fees", async () => {
    const admin = await createUser({ rest: { isAdmin: true } });
    const longAgo = new Date(Date.now() - 400 * 86400000);
    await createUser({
      basic: { gender: "Female", referralId: "REFX" },
      rest: {
        transactions: [
          { amountPaid: 1000, note: "Registration", dateOfTrans: new Date() },
          { amountPaid: 500, amountRefunded: 500, note: "Interest Purchase", dateOfTrans: new Date() },
          { amountPaid: 9999, note: "Interest Purchase", dateOfTrans: longAgo },
        ],
      },
    });
    await createBroker({ transactions: [{ amountPaid: 2000, note: "Broker Registration", dateOfTrans: new Date() }] });

    const res = await api().get("/api/manage/period?period=today").set("x-auth-token", tokenFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.members).toMatchObject({ joined: 2, female: 1, male: 1, referred: 1 });
    expect(res.body.partnersJoined).toBe(1);
    expect(res.body.revenue.total).toBe(3000);
    expect(res.body.revenue.refunded).toBe(500);
    expect(res.body.revenue.byType.partner).toEqual({ total: 2000, count: 1 });
  });

  it("is admin only", async () => {
    const member = await createUser();
    const res = await api().get("/api/manage/period").set("x-auth-token", tokenFor(member));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.revenue).toBeUndefined();
  });
});
