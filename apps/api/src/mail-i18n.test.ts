import { INSTANCE_DEFAULTS } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { EN, FR } from "./mail.test-helpers.js";
import {
  adminAccessMailBody,
  adminAccessMailSubject,
  mailVoice,
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
    expect(notificationSubject(EN, "mention", TABLE)).toBe(
      `You were mentioned in "${TABLE}"`,
    );
    expect(notificationSubject(EN, "assigned", TABLE)).toContain(TABLE);
  });

  it("formats French subjects with placeholders", () => {
    expect(notificationSubject(FR, "mention", TABLE)).toBe(
      `Vous avez été mentionné dans «\u00a0${TABLE}\u00a0»`,
    );
    expect(notificationSubject(FR, "webhook_disabled", TABLE)).toContain(
      "«\u00a0Sales\u00a0»",
    );
  });
});

describe("notificationMailSubject", () => {
  it("prefixes the product name", () => {
    expect(notificationMailSubject(EN, "reply", TABLE)).toBe(
      `AnyGridDB: New reply in "${TABLE}"`,
    );
    expect(notificationMailSubject(FR, "reply", TABLE)).toContain(
      "AnyGridDB\u00a0: ",
    );
  });
});

describe("invitationMail", () => {
  it("includes the base name in the subject", () => {
    expect(invitationMailSubject(EN, "Ops")).toBe(
      'AnyGridDB: invitation to "Ops"',
    );
    expect(invitationMailSubject(FR, "Ops")).toBe(
      "AnyGridDB\u00a0: invitation à «\u00a0Ops\u00a0»",
    );
  });

  it("builds a body with link and expiry", () => {
    const body = invitationMailBody(EN, {
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
    expect(webhookDisabledMailSubject(EN)).toBe("AnyGridDB: webhook disabled");
    expect(webhookDisabledMailBody(EN, "CRM hook")).toContain('"CRM hook"');
    expect(webhookDisabledMailBody(FR, "CRM hook")).toContain(
      "«\u00a0CRM hook\u00a0»",
    );
  });
});

describe("security mails", () => {
  const until = new Date("2026-11-09T10:15:00Z");

  it("says why an account is locked, and until when", () => {
    const notice = { kind: "locked", failures: 10, until } as const;
    expect(securityMailSubject(EN, notice)).toBe(
      "AnyGridDB: your account is locked",
    );
    expect(securityMailBody(EN, notice)).toContain(
      "After 10 failed sign-in attempts",
    );
    expect(securityMailBody(EN, notice)).toContain("10:15 UTC");
    expect(securityMailBody(FR, { ...notice, until: null })).toContain(
      "jusqu’à ce qu’un administrateur le déverrouille",
    );
  });

  it("warns of a changed password and removed factors", () => {
    expect(securityMailSubject(FR, { kind: "password_changed" })).toBe(
      "AnyGridDB\u00a0: votre mot de passe a changé",
    );
    expect(securityMailBody(EN, { kind: "factors_removed" })).toContain(
      "tell your administrator",
    );
  });

  it("sends a reset link that works once, and leaves factors alone", () => {
    const body = resetMailBody(EN, {
      link: "https://grid.example.org/reset/abc",
      expiresAt: until,
      byAdmin: true,
    });
    expect(body).toContain("An administrator sent you");
    expect(body).toContain("https://grid.example.org/reset/abc");
    expect(body).toContain("Your second factors stay");
    expect(resetMailSubject(FR)).toBe(
      "AnyGridDB\u00a0: choisir un nouveau mot de passe",
    );
  });
});

describe("the instance's voice (ADR 0072)", () => {
  const settings = {
    ...INSTANCE_DEFAULTS,
    defaultLocale: "fr" as const,
    instanceName: "Registre",
    mailSignatureEn: "The data team",
    mailSignatureFr: "L’équipe données",
    mailInvitationFr: "Réservé au personnel de l’étude.",
  };

  it("is the product's until the instance says otherwise", () => {
    expect(EN).toEqual({
      locale: "en",
      name: "AnyGridDB",
      sender: null,
      signature: null,
      invitationNote: null,
    });
  });

  it("speaks the reader's language, else the instance's", () => {
    expect(mailVoice(settings)).toMatchObject({
      locale: "fr",
      signature: "L’équipe données",
      invitationNote: "Réservé au personnel de l’étude.",
    });
    expect(mailVoice(settings, "en")).toMatchObject({
      locale: "en",
      signature: "The data team",
      invitationNote: null,
    });
  });

  it("sends under the instance's name unless a sender name is set", () => {
    expect(mailVoice(settings).sender).toBe("Registre");
    expect(
      mailVoice({ ...settings, mailSenderName: "Support Registre" }).sender,
    ).toBe("Support Registre");
  });

  it("puts the instance's name where the product's was", () => {
    const voice = mailVoice(settings);
    expect(resetMailSubject(voice)).toBe(
      "Registre\u00a0: choisir un nouveau mot de passe",
    );
    expect(securityMailBody(voice, { kind: "password_changed" })).toContain(
      "votre compte Registre",
    );
    expect(notificationSubject(voice, "row_changed", TABLE)).toBe(
      "Une ligne verrouillée de «\u00a0Sales\u00a0» a changé sans passer par Registre",
    );
    expect(securityMailBody(voice, { kind: "password_changed" })).not.toContain(
      "AnyGridDB",
    );
  });

  it("adds the instance's note to an invitation, and keeps the link", () => {
    const body = invitationMailBody(mailVoice(settings), {
      inviterName: "Ada",
      link: "https://app.example/invite/token",
      expiresDate: "2026-12-01",
    });
    expect(body).toBe(
      "Ada vous invite sur Registre.\n\nRéservé au personnel de l’étude.\n\nhttps://app.example/invite/token\n\nLe lien expire le 2026-12-01.",
    );
  });
});

describe("an administrator's way into a base (ADR 0074)", () => {
  const until = new Date("2026-11-14T10:15:00Z");
  const link = "https://grid.example.org/b/1/settings";

  it("tells an owner who opened their base, why, and until when", () => {
    const notice = {
      mode: "emergency",
      adminName: "Ada",
      baseName: "Ventes",
      reason: "Une facture bloque la clôture.",
      until,
    } as const;
    expect(adminAccessMailSubject(FR, notice)).toBe(
      "AnyGridDB\u00a0: un administrateur a ouvert «\u00a0Ventes\u00a0»",
    );
    const body = adminAccessMailBody(FR, notice, link);
    expect(body).toContain(
      "Ada, qui administre AnyGridDB, a ouvert votre base",
    );
    expect(body).toContain("sans rien y modifier");
    expect(body).toContain("10:15 UTC");
    expect(body).toContain("Une facture bloque la clôture.");
    expect(body).toContain(link);
  });

  it("tells an owner of a role an administrator gave themselves", () => {
    const notice = {
      mode: "role",
      adminName: "Ada",
      baseName: "Sales",
      reason: "Its only owner left.",
      role: "owner",
    } as const;
    expect(adminAccessMailSubject(EN, notice)).toBe(
      'AnyGridDB: an administrator gave themselves a role on "Sales"',
    );
    const body = adminAccessMailBody(EN, notice, link);
    expect(body).toContain("gave themselves the role of owner");
    expect(body).toContain("Its only owner left.");
  });
});
