import { describe, expect, it, vi } from "vitest";
import sendEmail from "../src/config/msg91Email.js";
import sendWhatsappOTP from "../src/config/msg91Whatsapp.js";
import upStash from "../src/config/upStash.js";
import { api, createBroker } from "./helpers.js";

const email = "lakshmi@example.test";
const mobile = "9000000001";
const form = {
  name: "Lakshmi", email, phone: mobile, companyName: "LM", address: "Mysuru", caste: ["Brahmin"], password: "Secret@123",
  idProofs: [{ url: "https://ik.example.test/id.jpg", fileId: "id1" }],
};

let ipSeq = 0;
const ip = () => `198.51.100.${++ipSeq}`;
const post = (path, body) => api().post(`/api${path}`).set("X-Forwarded-For", ip()).send(body);

/** Sends the OTPs and reads back the codes that went out by email and WhatsApp. */
const sendCodes = async (contact = { email, mobile }) => {
  const res = await post("/broker-send-otp", contact);
  expect(res.status).toBe(200);
  const emailOtp = vi.mocked(sendEmail).mock.calls.at(-1)[0].variables.otp;
  const mobileOtp = vi.mocked(sendWhatsappOTP).mock.calls.at(-1)[1];
  return { emailOtp, mobileOtp };
};

describe("partner sign-up OTP", () => {
  it("sends one code by email and one by WhatsApp", async () => {
    await sendCodes();
    expect(vi.mocked(sendEmail).mock.calls[0][0].to).toEqual([{ email }]);
    expect(vi.mocked(sendWhatsappOTP).mock.calls[0][0]).toBe(`91${mobile}`);
  });

  it("rejects an invalid number or an email already used by a partner", async () => {
    expect((await post("/broker-send-otp", { email, mobile: "123" })).status).toBe(400);
    const existing = await createBroker();
    const res = await post("/broker-send-otp", { email: existing.email, mobile });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("verifies both codes and then lets that email + number pay", async () => {
    await upStash.set("upload:id1", "1");
    const codes = await sendCodes();
    const res = await post("/broker-verify-otp", { email, mobile, ...codes });
    expect(res.status).toBe(200);
    expect(res.body.verificationToken).toEqual(expect.any(String));

    const order = await post("/create-order", { purpose: "broker", broker: { ...form, verificationToken: res.body.verificationToken } });
    expect(order.status).toBe(200);
  });

  it("refuses a wrong code and gives up after five tries", async () => {
    const codes = await sendCodes();
    const wrong = { email, mobile, emailOtp: codes.emailOtp, mobileOtp: "000000" === codes.mobileOtp ? "111111" : "000000" };
    const first = await post("/broker-verify-otp", wrong);
    expect(first.status).toBe(400);
    expect(first.body.msg).toBe("Invalid WhatsApp OTP");
    for (let i = 0; i < 4; i++) await post("/broker-verify-otp", wrong);
    const after = await post("/broker-verify-otp", { email, mobile, ...codes });
    expect(after.body.msg).toBe("OTP not found or expired");
  });

  it("won't take payment without a verification for the same email + number", async () => {
    expect((await post("/create-order", { purpose: "broker", broker: form })).status).toBe(400);

    await upStash.set("broker_verified:other", JSON.stringify({ email: "someone@example.test", phone: mobile }));
    const res = await post("/create-order", { purpose: "broker", broker: { ...form, verificationToken: "other" } });
    expect(res.status).toBe(400);
    expect(res.body.msg).toMatch(/verify your email and phone/);
  });
});
