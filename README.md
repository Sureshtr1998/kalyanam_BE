# kalyanam_BE

Express + MongoDB API for Seetha Rama Kalyana.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev
```

`src/config/env.js` loads `.env` and refuses to start when a required
variable is missing; it logs a warning for recommended ones (webhook secret,
QStash, WhatsApp, astrology keys) and for risky production settings
(test Razorpay key, `TEST_PAYMENT_EMAILS`, short `JWT_SECRET`). CORS allows
`FRONTEND_URL` (plus its www/apex twin) and `CORS_ORIGINS`.

`GET /api/health` is a database-free liveness check for uptime monitors.

## Tests

```bash
npm test
```

API tests (`tests/`) drive the real Express app with supertest against an
in-memory MongoDB (downloaded by `mongodb-memory-server` on first run).
Razorpay, Upstash, MSG91 and ImageKit are faked, and the fake config in
`tests/.env.test` is used instead of your `.env`. They cover server-side
pricing, checkout and webhook signature checks, idempotent fulfilment for
every purchase type, rate limiting, CORS, security headers and auth.
