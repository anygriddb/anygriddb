import { describe, expect, it } from "vitest";
import { RATE_LIMITS, rateBucket } from "./rate-limit.js";

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
    ]) {
      expect(rateBucket("POST", `/trpc/${procedure}`)).toBe("auth");
    }
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
