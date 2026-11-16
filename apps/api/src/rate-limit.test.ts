import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  credentialCalls,
  RATE_LIMITS,
  rateBucket,
  registerRateLimit,
} from "./rate-limit.js";

describe("rateBucket", () => {
  it("puts credential checks and public shares in tight buckets", () => {
    expect(rateBucket("POST", "/trpc/auth.login?batch=1")).toBe("auth");
    expect(
      rateBucket("POST", "/trpc/session.current,auth.totp.verify?batch=1"),
    ).toBe("auth");
    expect(rateBucket("POST", "/trpc/rows.sign")).toBe("auth");
    for (const procedure of [
      "auth.changePassword",
      "auth.requestPasswordReset",
      "auth.resetLink",
      "auth.resetPassword",
      "auth.confirmSignup",
      "auth.email.send",
      "auth.email.verify",
    ]) {
      expect(rateBucket("POST", `/trpc/${procedure}`)).toBe("auth");
    }
    // A proof a signed-in person gives is held by the account's lock, not
    // by the address: setting up an account must not use up the sign-ins.
    for (const procedure of [
      "auth.totp.confirm",
      "auth.email.begin",
      "auth.email.disable",
      "auth.webauthn.registerBegin",
      "admin.stepUp",
    ]) {
      expect(rateBucket("POST", `/trpc/${procedure}`)).toBe("app");
      expect(credentialCalls(`/trpc/${procedure}`)).toBe(1);
    }
    // An application's secret is checked there (ADR 0094).
    expect(rateBucket("POST", "/oauth/token")).toBe("auth");
    expect(rateBucket("POST", "/oauth/revoke")).toBe("auth");
    expect(rateBucket("GET", "/oauth/authorize?client_id=x")).toBe("app");

    expect(rateBucket("GET", "/trpc/share.rows?input=x")).toBe("share");
    // A sign-up's link only names its address: opened as a share is.
    expect(
      rateBucket("GET", "/trpc/auth.instance,auth.signupLink?batch=1"),
    ).toBe("share");
    expect(rateBucket("POST", "/hooks/automations/aghook_x")).toBe("share");
    expect(rateBucket("GET", "/ical/agcal_x.ics")).toBe("share");
    expect(rateBucket("POST", "/api/attachments?tableId=x")).toBe("upload");
    // A file for a public form: people without an account, a tighter limit.
    expect(rateBucket("POST", "/api/shares/tok/attachments?field=f")).toBe(
      "formUpload",
    );
    expect(RATE_LIMITS.formUpload).toBeLessThan(RATE_LIMITS.upload);
    expect(rateBucket("POST", "/api/import/preview?baseId=x")).toBe("upload");
    expect(rateBucket("GET", "/api/export/x?format=csv")).toBe("app");
    expect(rateBucket("GET", "/api/v1/tables/x/records")).toBe("api");
    // The administration API counts with the others (ADR 0086).
    expect(rateBucket("PATCH", "/api/v1/admin/settings")).toBe("api");
    expect(rateBucket("GET", "/api/v1/admin/openapi.json")).toBe("api");
    expect(rateBucket("POST", "/mcp")).toBe("api");
    expect(rateBucket("POST", "/api/client-errors")).toBe("report");
    expect(rateBucket("PATCH", "/scim/v2/Users/x")).toBe("api");
  });

  it("leaves ordinary app traffic and look-alike names in the wide bucket", () => {
    expect(rateBucket("GET", "/trpc/rows.read?input=x")).toBe("app");
    expect(rateBucket("GET", "/trpc/catalog.shares?input=x")).toBe("app");
    expect(rateBucket("GET", "/trpc/auth.tokens")).toBe("app");
    expect(rateBucket("GET", "/api/attachments/attabc")).toBe("app");
    expect(rateBucket("GET", "/api/shares/tok/attachments")).toBe("app");
    expect(rateBucket("POST", "/api/client-errors/x")).toBe("app");
  });
});

describe("credentialCalls", () => {
  it("counts the calls of a request that check a credential", () => {
    expect(credentialCalls("/trpc/rows.read?input=x")).toBe(0);
    expect(credentialCalls("/trpc/session.current,auth.login?batch=1")).toBe(1);
    expect(credentialCalls("/trpc/auth.login,auth.login,auth.login")).toBe(3);
    expect(credentialCalls("/trpc/auth.login%2Cauth.totp.verify?batch=1")).toBe(
      2,
    );
    expect(credentialCalls("/api/v1/tables/x/records")).toBe(0);
  });
});

describe("registerRateLimit", () => {
  async function app() {
    const server = Fastify();
    await registerRateLimit(server);
    server.post("/trpc/:calls", () => ({ reached: true }));
    return server;
  }

  it("takes a request that names one credential check, among other calls", async () => {
    const server = await app();
    const response = await server.inject({
      method: "POST",
      url: "/trpc/session.current,auth.login?batch=1",
    });
    expect(response.statusCode).toBe(200);
    await server.close();
  });

  it("refuses a request that names several: each would be a guess counted once", async () => {
    const server = await app();
    const response = await server.inject({
      method: "POST",
      url: "/trpc/auth.login,auth.login?batch=1",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "request_rejected" });
    await server.close();
  });
});
