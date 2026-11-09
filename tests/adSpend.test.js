import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, createUser, tokenFor } from "./helpers.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** Answers the two Graph API calls the route makes: the account, then insights. */
const fakeMeta = (rows) =>
  vi.fn(async (url) => {
    const path = new URL(url).pathname;
    const body = path.endsWith("/insights")
      ? { data: rows }
      : { name: "Test account", currency: "INR", timezone_name: "Asia/Kolkata", account_status: 1 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });

describe("GET /manage/ad-spend", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.META_ADS_TOKEN = "test-token";
    process.env.META_AD_ACCOUNT_ID = "123";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.META_ADS_TOKEN;
    delete process.env.META_AD_ACCOUNT_ID;
  });

  it("reports not configured without a token", async () => {
    delete process.env.META_ADS_TOKEN;
    const admin = await createUser({ rest: { isAdmin: true } });
    const res = await api().get("/api/manage/ad-spend").set("x-auth-token", tokenFor(admin));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it("merges Meta spend with today's direct and partner sign-ups", async () => {
    globalThis.fetch = fakeMeta([
      {
        date_start: today(),
        spend: "600.50",
        clicks: "90",
        inline_link_clicks: "80",
        actions: [
          { action_type: "offsite_conversion.fb_pixel_lead", value: "5" },
          { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "2" },
        ],
      },
    ]);
    const admin = await createUser({ rest: { isAdmin: true } });
    await createUser();
    await createUser({ basic: { referralId: "REF1" }, rest: { transactions: [{ amountPaid: 1000, amountRefunded: 100, dateOfTrans: new Date() }] } });

    const res = await api().get("/api/manage/ad-spend?refresh=1").set("x-auth-token", tokenFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(14);
    const last = res.body.days.at(-1);
    expect(last).toMatchObject({ date: today(), spend: 600.5, clicks: 80, leads: 5, registrations: 2, joined: 3, direct: 2, earned: 900 });
    // Days Meta leaves out are filled with zeros.
    expect(res.body.days[0]).toMatchObject({ spend: 0, registrations: 0 });
  });

  it("is admin only", async () => {
    const member = await createUser();
    const res = await api().get("/api/manage/ad-spend").set("x-auth-token", tokenFor(member));
    expect(res.status).not.toBe(200);
  });
});
