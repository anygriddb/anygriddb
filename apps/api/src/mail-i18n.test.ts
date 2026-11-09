import { describe, expect, it } from "vitest";
import {
  invitationMailBody,
  invitationMailSubject,
  notificationMailSubject,
  notificationSubject,
  resetMailBody,
  resetMailSubject,
  resolveLocale,
  securityMailBody,
  securityMailSubject,
  webhookDisabledMailBody,
  webhookDisabledMailSubject,
} from "./mail-i18n.js";

const TABLE = "Sales";

describe("resolveLocale", () => {
  it("prefers the user locale, then the instance default, then English", () => {
    expect(resolveLocale("fr", "en")).toBe("fr");
    expect(resolveLocale(null, "fr")).toBe("fr");
    expect(resolveLocale(undefined, undefined)).toBe("en");
  });
});

describe("notificationSubject", () => {
  it("formats English subjects with placeholders", () => {
    expect(notificationSubject("en", "mention", TABLE)).toBe(
      `You were mentioned in "${TABLE}"`,
    );
    expect(notificationSubject("en", "assigned", TABLE)).toContain(TABLE);
  });

  it("formats French subjects with placeholders", () => {
    expect(notificationSubject("fr", "mention", TABLE)).toBe(
      `Vous avez été mentionné dans « ${TABLE} »`,
    );
    expect(notificationSubject("fr", "webhook_disabled", TABLE)).toContain(
      "« Sales »",
    );
  });
});

describe("notificationMailSubject", () => {
  it("prefixes the product name", () => {
    expect(notificationMailSubject("en", "reply", TABLE)).toBe(
      `AnyGridDB: New reply in "${TABLE}"`,
    );
    expect(notificationMailSubject("fr", "reply", TABLE)).toContain(
      "AnyGridDB : ",
    );
  });
});

describe("invitationMail", () => {
  it("includes the base name in the subject", () => {
    expect(invitationMailSubject("en", "Ops")).toBe(
      'AnyGridDB: invitation to "Ops"',
    );
    expect(invitationMailSubject("fr", "Ops")).toBe(
      "AnyGridDB : invitation à « Ops »",
    );
  });

  it("builds a body with link and expiry", () => {
    const body = invitationMailBody("en", {
      inviterName: "Ada",
      link: "https://app.example/invite/token",
      expiresDate: "2026-12-01",
    });
    expect(body).toContain("Ada");
    expect(body).toContain("https://app.example/invite/token");
    expect(body).toContain("2026-12-01");
  });
});

describe("webhookDisabledMail", () => {
  it("names the webhook in the body", () => {
    expect(webhookDisabledMailSubject("en")).toBe(
      "AnyGridDB: webhook disabled",
    );
    expect(webhookDisabledMailBody("en", "CRM hook")).toContain('"CRM hook"');
    expect(webhookDisabledMailBody("fr", "CRM hook")).toContain("« CRM hook »");
  });
});

describe("security mails", () => {
  const until = new Date("2026-11-09T10:15:00Z");

  it("says why an account is locked, and until when", () => {
    const notice = { kind: "locked", failures: 10, until } as const;
    expect(securityMailSubject("en", notice)).toBe(
      "AnyGridDB: your account is locked",
    );
    expect(securityMailBody("en", notice)).toContain(
      "After 10 failed sign-in attempts",
    );
    expect(securityMailBody("en", notice)).toContain("10:15 UTC");
    expect(securityMailBody("fr", { ...notice, until: null })).toContain(
      "jusqu'à ce qu'un administrateur le déverrouille",
    );
  });

  it("warns of a changed password and removed factors", () => {
    expect(securityMailSubject("fr", { kind: "password_changed" })).toBe(
      "AnyGridDB : votre mot de passe a changé",
    );
    expect(securityMailBody("en", { kind: "factors_removed" })).toContain(
      "tell your administrator",
    );
  });

  it("sends a reset link that works once, and leaves factors alone", () => {
    const body = resetMailBody("en", {
      link: "https://grid.example.org/reset/abc",
      expiresAt: until,
      byAdmin: true,
    });
    expect(body).toContain("An administrator sent you");
    expect(body).toContain("https://grid.example.org/reset/abc");
    expect(body).toContain("Your second factors stay");
    expect(resetMailSubject("fr")).toBe(
      "AnyGridDB : choisir un nouveau mot de passe",
    );
  });
});
