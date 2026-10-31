import { describe, expect, it } from "vitest";
import { api, createUser, PASSWORD, tokenFor } from "./helpers.js";

describe("app", () => {
  it("answers the health check without a database round-trip", async () => {
    const res = await api().get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("sends security headers and hides the framework", async () => {
    const res = await api().get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("returns JSON 404 for unknown routes", async () => {
    const res = await api().get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.msg).toBe("Not found");
  });

  it("rejects malformed JSON with 400, not 500", async () => {
    const res = await api()
      .post("/api/login")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
  });

  describe("CORS", () => {
    const originHeader = (origin) =>
      api().get("/api/health").set("Origin", origin).then((r) => r.headers["access-control-allow-origin"]);

    it("allows FRONTEND_URL, its www/apex twin and CORS_ORIGINS", async () => {
      expect(await originHeader("https://www.example.test")).toBe("https://www.example.test");
      expect(await originHeader("https://example.test")).toBe("https://example.test");
      expect(await originHeader("https://preview.example.test")).toBe("https://preview.example.test");
    });

    it("refuses other origins", async () => {
      expect(await originHeader("https://evil.example.com")).toBeUndefined();
    });
  });
});

describe("auth", () => {
  it("logs a member in with the right password", async () => {
    const user = await createUser();
    const res = await api().post("/api/login").send({ email: user.basic.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    expect(res.body.role).toBe("USER");
  });

  it("rejects a wrong password without saying which field was wrong", async () => {
    const user = await createUser();
    const res = await api().post("/api/login").send({ email: user.basic.email, password: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.msg).toBe("Invalid credentials");
  });

  it("protects member routes", async () => {
    expect((await api().get("/api/my-profile")).status).toBe(401);
    expect((await api().get("/api/my-profile").set("x-auth-token", "garbage")).status).toBe(401);
  });

  it("never returns the password hash", async () => {
    const user = await createUser();
    const res = await api().get("/api/my-profile").set("x-auth-token", tokenFor(user));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(user.basic.password);
  });

  it("refuses a wrong internal secret", async () => {
    const user = await createUser();
    const res = await api()
      .post("/api/buy-interest")
      .set("x-internal-secret", "wrong")
      .send({ email: user.basic.email, orderId: "order_x", paymentId: "pay_x" });
    expect(res.status).toBe(401);
  });
});
