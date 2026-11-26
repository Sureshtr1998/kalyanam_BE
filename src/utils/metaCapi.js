import crypto from "crypto";

/*
 * Meta Conversions API: tells Meta about sign-ups from the server, so
 * joins the browser pixel misses (blockers, closed tabs, in-app browsers,
 * the Razorpay webhook path) still count, and Meta's delivery learns from
 * every member. The browser pixel sends the same event with the same
 * event id, and Meta keeps one of the two.
 *
 * Needs a token with access to the pixel (dataset): META_CAPI_TOKEN, or the
 * ads system-user token when the pixel is assigned to that system user.
 * META_CAPI_TEST_CODE sends events to Events Manager → Test events instead.
 * Never throws and never holds a request up for more than 4 seconds.
 */

const GRAPH = "https://graph.facebook.com/v22.0";
// The site's public pixel id (it is in every page's HTML); META_PIXEL_ID overrides it.
const PIXEL = () => process.env.META_PIXEL_ID || "1199725088340553";
const TOKEN = () => process.env.META_CAPI_TOKEN || process.env.META_ADS_TOKEN;
const SITE = () => (process.env.SITE_URL || "https://www.seetharamakalyana.in").replace(/\/+$/, "");

export const capiConfigured = () => !!TOKEN() && process.env.META_CAPI !== "off";

const sha = (v) => (v ? crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex") : undefined);
const clean = (s, max = 300) => (typeof s === "string" ? s.slice(0, max) : undefined);

/**
 * What the browser sent with a sign-up (Meta cookies, the ad's utm tags)
 * plus the visitor's IP and browser, read from the request.
 * @param {import("express").Request} req
 */
export const trackingFrom = (req) => {
  const t = req.body?.tracking && typeof req.body.tracking === "object" ? req.body.tracking : {};
  const forwarded = String(req.header?.("x-forwarded-for") || "").split(",")[0].trim();
  return {
    eventId: clean(t.eventId, 100),
    fbp: clean(t.fbp, 200),
    fbc: clean(t.fbc, 400),
    sourceUrl: clean(t.sourceUrl, 500),
    utmSource: clean(t.utmSource, 100),
    utmMedium: clean(t.utmMedium, 100),
    utmCampaign: clean(t.utmCampaign, 150),
    utmContent: clean(t.utmContent, 150),
    fbclid: clean(t.fbclid, 300),
    landing: clean(t.landing, 200),
    ip: forwarded || req.ip || req.socket?.remoteAddress || undefined,
    userAgent: clean(req.header?.("user-agent"), 500),
  };
};

/** The member's acquisition record from the tracking data (stored on the User). */
export const acquisitionFrom = (t = {}) => {
  const out = {
    utmSource: t.utmSource,
    utmMedium: t.utmMedium,
    utmCampaign: t.utmCampaign,
    utmContent: t.utmContent,
    fbclid: t.fbclid,
    landing: t.landing,
  };
  return Object.values(out).some(Boolean) ? out : undefined;
};

/** Meta's user_data: hashed contact details plus the unhashed browser ids. */
export const userData = ({ email, mobile, fullName, gender, externalId }, t = {}) => {
  const digits = String(mobile || "").replace(/\D/g, "").slice(-10);
  const [first, ...rest] = String(fullName || "").trim().toLowerCase().replace(/[^\p{L}\s]/gu, "").split(/\s+/);
  const g = String(gender || "").toLowerCase();
  const data = {
    em: email ? [sha(email)] : undefined,
    ph: digits.length === 10 ? [sha(`91${digits}`)] : undefined,
    fn: first ? [sha(first)] : undefined,
    ln: rest.length ? [sha(rest.join(""))] : undefined,
    ge: g.startsWith("m") ? [sha("m")] : g.startsWith("f") ? [sha("f")] : undefined,
    country: [sha("in")],
    external_id: externalId ? [sha(externalId)] : undefined,
    client_ip_address: t.ip,
    client_user_agent: t.userAgent,
    fbp: t.fbp,
    fbc: t.fbc,
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v != null));
};

/**
 * Sends one website event to Meta. Returns true when Meta accepted it.
 * @param {{ event: string, eventId: string, value?: number, currency?: string, user: object, tracking?: object, contentName?: string }} e
 */
export const sendConversion = async ({ event, eventId, value, currency = "INR", user, tracking = {}, contentName }) => {
  if (!capiConfigured() || !eventId) return false;
  try {
    const body = {
      data: JSON.stringify([
        {
          event_name: event,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: "website",
          event_source_url: tracking.sourceUrl || `${SITE()}/`,
          user_data: userData(user, tracking),
          custom_data: { value: value ?? 0, currency, ...(contentName ? { content_name: contentName } : {}) },
        },
      ]),
      ...(process.env.META_CAPI_TEST_CODE ? { test_event_code: process.env.META_CAPI_TEST_CODE } : {}),
    };
    const res = await fetch(`${GRAPH}/${PIXEL()}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN()}` },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(4000),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) {
      console.error("[capi]", event, out.error?.message || res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[capi]", event, err.message);
    return false;
  }
};
