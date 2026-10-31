import { beforeEach, describe, expect, it, vi } from "vitest";
import razorpay from "../src/config/razorpay.js";
import upStash, { publishQStash } from "../src/config/upStash.js";
import User from "../src/models/User.js";
import Broker from "../src/models/Broker.js";
import {
  ASTRO_FEES,
  BROKER_REGISTRATION_FEE,
  INTEREST_PACKS,
  REFERRAL_REGISTRATION_FEE,
  REGISTRATION_FEE,
  REGISTRATION_INTERESTS,
} from "../src/utils/constants.js";
import {
  api,
  createBroker,
  createUser,
  paidOrder,
  registrationForm,
  tokenFor,
  webhookSignature,
} from "./helpers.js";

// registrationForm()'s photo, as if uploaded through /user-register/upload-images.
beforeEach(() => upStash.set("upload:asha", "1"));

const storedOrder = (orderId) => upStash.get(`rzp_order:${orderId}`);

// /create-order is rate limited per client IP; give each call its own so the
// suite doesn't trip the limiter (it has its own test below).
let ipSeq = 0;
const freshIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

const createOrder = (body, token, ip = freshIp()) => {
  const req = api().post("/api/create-order").set("X-Forwarded-For", ip);
  if (token) req.set("x-auth-token", token);
  return req.send(body);
};

const astroRequest = (overrides = {}) => ({
  consultationMode: "Overview",
  name: "Asha Rao",
  place: "Mysuru, Karnataka, India",
  lat: 12.3,
  lng: 76.6,
  gender: "Female",
  dob: "1996-05-20T10:30",
  ...overrides,
});

describe("POST /create-order (pricing)", () => {
  it("prices a registration on the server and stores the validated form", async () => {
    const res = await createOrder({ purpose: "registration", registration: registrationForm() });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: REGISTRATION_FEE * 100, currency: "INR", userEmail: "asha@example.test" });
    const record = await storedOrder(res.body.orderId);
    expect(record).toMatchObject({ purpose: "registration", amount: REGISTRATION_FEE, interests: REGISTRATION_INTERESTS });
    // The plain password never reaches Redis.
    expect(JSON.stringify(record)).not.toContain("Secret@123");
    expect(record.registration.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("ignores any amount the browser sends", async () => {
    const res = await createOrder({ purpose: "interest", pack: "basic", amount: 1 }, tokenFor(await createUser()));
    expect(res.status).toBe(200);
    expect(razorpay.orders.create).toHaveBeenCalledWith(expect.objectContaining({ amount: INTEREST_PACKS.basic.amount * 100 }));
  });

  it("gives the referral price for an active partner's code", async () => {
    const broker = await createBroker();
    const res = await createOrder({ purpose: "registration", registration: registrationForm({ referralId: broker.referralId.toLowerCase() }) });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(REFERRAL_REGISTRATION_FEE * 100);
  });

  it("rejects unknown and self-referral codes before payment", async () => {
    const unknown = await createOrder({ purpose: "registration", registration: registrationForm({ referralId: "NOPE123" }) });
    expect(unknown.status).toBe(400);
    expect(unknown.body.msg).toBe("Invalid referral ID");

    const broker = await createBroker({ email: "asha@example.test" });
    const self = await createOrder({ purpose: "registration", registration: registrationForm({ referralId: broker.referralId }) });
    expect(self.status).toBe(400);
    expect(razorpay.orders.create).not.toHaveBeenCalled();
  });

  it("does not take money for a registration that would fail", async () => {
    await createUser({ basic: { email: "asha@example.test" } });
    const cases = [
      registrationForm(), // email taken
      registrationForm({ email: "new@example.test", mobile: "123" }),
      registrationForm({ email: "new@example.test", dob: "2015-01-01" }),
      registrationForm({ email: "new@example.test", images: [] }),
      registrationForm({ email: "new@example.test", password: "123" }),
    ];
    for (const registration of cases) {
      const res = await createOrder({ purpose: "registration", registration });
      expect(res.status).toBe(400);
    }
    expect(razorpay.orders.create).not.toHaveBeenCalled();
  });

  it("requires login for interest packs and astrology", async () => {
    expect((await createOrder({ purpose: "interest", pack: "basic" })).status).toBe(401);
    expect((await createOrder({ purpose: "astro", astro: astroRequest() })).status).toBe(401);
  });

  it("prices each interest pack, and rejects unknown ones", async () => {
    const token = tokenFor(await createUser());
    for (const [pack, plan] of Object.entries(INTEREST_PACKS)) {
      const res = await createOrder({ purpose: "interest", pack }, token);
      expect(res.body.amount).toBe(plan.amount * 100);
    }
    expect((await createOrder({ purpose: "interest", pack: "gold" }, token)).status).toBe(400);
  });

  it("prices every astrology mode", async () => {
    const token = tokenFor(await createUser());
    const extras = {
      Personalized: { query: "When will I get married?" },
      "Kundli Matching": { mName: "Ravi", mPlace: "Udupi", mLat: 13.3, mLng: 74.7, mGender: "Male", mDob: "1993-02-11T06:00" },
    };
    for (const [mode, fee] of Object.entries(ASTRO_FEES)) {
      const res = await createOrder({ purpose: "astro", astro: astroRequest({ consultationMode: mode, ...extras[mode] }) }, token);
      expect(res.status, mode).toBe(200);
      expect(res.body.amount).toBe(fee * 100);
    }
    expect((await createOrder({ purpose: "astro", astro: astroRequest({ consultationMode: "Free" }) }, token)).status).toBe(400);
  });

  it("prices partner registration", async () => {
    const res = await createOrder({
      purpose: "broker",
      broker: { name: "Lakshmi", email: "l@example.test", phone: "9000000001", companyName: "LM", address: "Mysuru", caste: ["Brahmin"], password: "Secret@123" },
    });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(BROKER_REGISTRATION_FEE * 100);
  });

  it("charges ₹1 to accounts in TEST_PAYMENT_EMAILS", async () => {
    const res = await createOrder({ purpose: "registration", registration: registrationForm({ email: "rupee@example.test" }) });
    expect(res.body.amount).toBe(100);
    expect((await storedOrder(res.body.orderId)).amountCharged).toBe(1);
  });

  it("charges admins ₹1 for anything", async () => {
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const astro = await createOrder({ purpose: "astro", astro: astroRequest({ consultationMode: "Personalized", query: "Career?" }) }, token);
    const pack = await createOrder({ purpose: "interest", pack: "premium" }, token);
    for (const res of [astro, pack]) {
      expect(res.body.amount).toBe(100);
      expect((await storedOrder(res.body.orderId)).amountCharged).toBe(1);
    }
  });

  it("rejects an unknown purpose", async () => {
    const res = await createOrder({ purpose: "donation" }, tokenFor(await createUser()));
    expect(res.status).toBe(400);
  });

  it("rate limits order creation per client", async () => {
    const statuses = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await createOrder({ purpose: "donation" }, undefined, "203.0.113.7")).status);
    }
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("keeps rate-limit counters in Redis, shared across instances", async () => {
    await createOrder({ purpose: "donation" }, undefined, "203.0.113.8");
    expect(upStash.eval).toHaveBeenCalledWith(expect.any(String), ["rl:order:203.0.113.8"], [String(10 * 60 * 1000)]);
  });

  it("lets requests through when Redis is unavailable", async () => {
    vi.mocked(upStash.eval).mockRejectedValueOnce(new Error("redis down"));
    const res = await createOrder({ purpose: "donation" }, undefined, "203.0.113.9");
    // Reached the handler (anonymous, so "please log in") instead of a 429/500.
    expect(res.status).toBe(401);
  });
});

describe("POST /user-register (registration fulfilment)", () => {
  const paidRegistration = async (form = registrationForm()) => {
    const { body } = await createOrder({ purpose: "registration", registration: form });
    return body.orderId;
  };

  it("creates the member from the stored order and logs them in", async () => {
    const orderId = await paidRegistration();
    const res = await api().post("/api/user-register").send({
      ...paidOrder(orderId),
      // Anything the browser adds after payment is ignored.
      fullName: "Hacker",
      interests: 9999,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    const user = await User.findOne({ "basic.email": "asha@example.test" });
    expect(user.basic.fullName).toBe("Asha Rao");
    expect(user.interests.totalNoOfInterest).toBe(REGISTRATION_INTERESTS);
    expect(user.transactions[0]).toMatchObject({ orderId, amountPaid: REGISTRATION_FEE });
    const record = await storedOrder(orderId);
    expect(record.fulfilled).toBe(true);
    expect(record.registration.passwordHash).toBeUndefined();
  });

  it("is idempotent: browser and webhook retry create one account", async () => {
    const orderId = await paidRegistration();
    const first = await api().post("/api/user-register").send(paidOrder(orderId));
    const browserRetry = await api().post("/api/user-register").send(paidOrder(orderId));
    const webhookRetry = await api()
      .post("/api/user-register")
      .set("x-internal-secret", process.env.INTERNAL_ROUTE_SECRET)
      .send({ orderId, paymentId: `pay_${orderId}`, email: "asha@example.test" });

    expect([first.status, browserRetry.status, webhookRetry.status]).toEqual([200, 200, 200]);
    expect(await User.countDocuments({ "basic.email": "asha@example.test" })).toBe(1);
  });

  it("rejects a forged checkout signature", async () => {
    const orderId = await paidRegistration();
    const res = await api().post("/api/user-register").send({ orderId, paymentId: "pay_1", signature: "0".repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.msg).toBe("Payment verification failed");
    expect(await User.countDocuments()).toBe(0);
  });

  it("rejects a signature for a different payment id", async () => {
    const orderId = await paidRegistration();
    const { signature } = paidOrder(orderId, "pay_real");
    const res = await api().post("/api/user-register").send({ orderId, paymentId: "pay_other", signature });
    expect(res.status).toBe(400);
  });

  it("rejects an order created for something else", async () => {
    const token = tokenFor(await createUser());
    const { body } = await createOrder({ purpose: "interest", pack: "basic" }, token);
    const res = await api().post("/api/user-register").send(paidOrder(body.orderId));
    expect(res.status).toBe(400);
    expect(res.body.msg).toBe("This payment does not belong to this action");
  });

  it("returns 404 with the payment id when the order is unknown or expired", async () => {
    const res = await api().post("/api/user-register").send(paidOrder("order_missing", "pay_123"));
    expect(res.status).toBe(404);
    expect(res.body.msg).toContain("pay_123");
  });

  it("requires order and payment ids", async () => {
    expect((await api().post("/api/user-register").send({})).status).toBe(400);
  });
});

describe("POST /buy-interest (credit pack fulfilment)", () => {
  const buy = async (user, pack = "basic") => {
    const { body } = await createOrder({ purpose: "interest", pack }, tokenFor(user));
    return body.orderId;
  };

  it("adds the pack's credits once", async () => {
    const user = await createUser();
    const orderId = await buy(user, "premium");

    const first = await api().post("/api/buy-interest").set("x-auth-token", tokenFor(user)).send(paidOrder(orderId));
    const again = await api().post("/api/buy-interest").set("x-auth-token", tokenFor(user)).send(paidOrder(orderId));

    expect(first.status).toBe(200);
    expect(first.body.alreadyApplied).toBe(false);
    expect(again.body.alreadyApplied).toBe(true);
    const fresh = await User.findById(user._id);
    expect(fresh.interests.totalNoOfInterest).toBe(36 + INTEREST_PACKS.premium.interests);
    expect(fresh.transactions).toHaveLength(1);
  });

  it("will not apply another member's payment", async () => {
    const payer = await createUser();
    const other = await createUser();
    const orderId = await buy(payer);
    const res = await api().post("/api/buy-interest").set("x-auth-token", tokenFor(other)).send(paidOrder(orderId));
    expect(res.status).toBe(403);
    expect((await User.findById(other._id)).interests.totalNoOfInterest).toBe(36);
  });

  it("rejects a forged signature", async () => {
    const user = await createUser();
    const orderId = await buy(user);
    const res = await api()
      .post("/api/buy-interest")
      .set("x-auth-token", tokenFor(user))
      .send({ orderId, paymentId: "pay_x", signature: "bad" });
    expect(res.status).toBe(400);
  });
});

describe("POST /astro-data (astrology fulfilment)", () => {
  it("records the reading request and schedules it once", async () => {
    const user = await createUser();
    const token = tokenFor(user);
    const { body } = await createOrder({ purpose: "astro", astro: astroRequest() }, token);

    const first = await api().post("/api/astro-data").set("x-auth-token", token).send(paidOrder(body.orderId));
    await api().post("/api/astro-data").set("x-auth-token", token).send(paidOrder(body.orderId));

    expect(first.status).toBe(201);
    const fresh = await User.findById(user._id);
    expect(fresh.astrology).toHaveLength(1);
    expect(fresh.astrology[0].status).toBe("pending");
    expect(publishQStash).toHaveBeenCalledTimes(1);
    expect(publishQStash).toHaveBeenCalledWith("astrology", expect.objectContaining({ email: user.basic.email }), expect.any(String));
  });

  it("schedules an admin's reading immediately", async () => {
    const token = tokenFor(await createUser({ rest: { isAdmin: true } }));
    const { body } = await createOrder({ purpose: "astro", astro: astroRequest() }, token);
    await api().post("/api/astro-data").set("x-auth-token", token).send(paidOrder(body.orderId));
    expect(publishQStash).toHaveBeenCalledWith("astrology", expect.any(Object), "0s");
  });
});

describe("POST /broker-register (partner fulfilment)", () => {
  it("creates a pending partner once", async () => {
    const { body } = await createOrder({
      purpose: "broker",
      broker: { name: "Lakshmi", email: "l@example.test", phone: "9000000001", companyName: "LM", address: "Mysuru", caste: ["Brahmin"], password: "Secret@123" },
    });
    const first = await api().post("/api/broker-register").send(paidOrder(body.orderId));
    const again = await api().post("/api/broker-register").send(paidOrder(body.orderId));

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const brokers = await Broker.find({ email: "l@example.test" });
    expect(brokers).toHaveLength(1);
    expect(brokers[0].status).toBe("pending");
    expect(brokers[0].referralId).toBeUndefined();
  });
});

describe("POST /razorpay-webhook", () => {
  const send = (payload, signature) => {
    const raw = JSON.stringify(payload);
    return api()
      .post("/api/razorpay-webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signature ?? webhookSignature(raw))
      .send(raw);
  };
  const captured = (orderId) => ({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_hook", order_id: orderId } } },
  });

  it("rejects an unsigned or wrongly signed call", async () => {
    const res = await send(captured("order_x"), "bad");
    expect(res.status).toBe(400);
    expect(publishQStash).not.toHaveBeenCalled();
  });

  it("queues fulfilment for a captured payment the browser never reported", async () => {
    const { body } = await createOrder({ purpose: "registration", registration: registrationForm() });
    const res = await send(captured(body.orderId));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(publishQStash).toHaveBeenCalledWith("user-register", {
      orderId: body.orderId,
      paymentId: "pay_hook",
      email: "asha@example.test",
    });
  });

  it("does nothing for an order that is already fulfilled", async () => {
    const { body } = await createOrder({ purpose: "registration", registration: registrationForm() });
    await api().post("/api/user-register").send(paidOrder(body.orderId));
    const res = await send(captured(body.orderId));
    expect(res.body.status).toBe("nothing to do");
    expect(publishQStash).not.toHaveBeenCalled();
  });

  it("ignores other events", async () => {
    const res = await send({ event: "payment.failed", payload: {} });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  it("a queued retry completes the registration with the internal secret", async () => {
    const { body } = await createOrder({ purpose: "registration", registration: registrationForm() });
    await send(captured(body.orderId));
    const [endpoint, payload] = vi.mocked(publishQStash).mock.calls[0];
    const res = await api().post(`/api/${endpoint}`).set("x-internal-secret", process.env.INTERNAL_ROUTE_SECRET).send(payload);
    expect(res.status).toBe(200);
    expect(await User.countDocuments({ "basic.email": "asha@example.test" })).toBe(1);
  });
});
