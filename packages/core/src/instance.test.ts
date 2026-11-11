import { describe, expect, it } from "vitest";
import {
  ADMIN_LOCK_MINUTES,
  INSTANCE_DEFAULTS,
  emailDomainAllowed,
  inactivityDates,
  instanceSettingsPatchSchema,
  instanceSettingsSchema,
  lockState,
  memberDomainAllowed,
  parseAdminEmails,
  parseInstanceSettings,
  sessionWindows,
  signupAllowed,
} from "./instance";

describe("signupAllowed", () => {
  it("always lets the first account in", () => {
    expect(
      signupAllowed("closed", { firstAccount: true, invited: false }),
    ).toBe(true);
  });

  it("follows the policy afterwards", () => {
    expect(signupAllowed("open", { firstAccount: false, invited: false })).toBe(
      true,
    );
    expect(
      signupAllowed("invite", { firstAccount: false, invited: true }),
    ).toBe(true);
    expect(
      signupAllowed("invite", { firstAccount: false, invited: false }),
    ).toBe(false);
    expect(
      signupAllowed("closed", { firstAccount: false, invited: true }),
    ).toBe(false);
  });
});

describe("parseAdminEmails", () => {
  it("splits, trims, and lowercases", () => {
    expect([
      ...parseAdminEmails(" Ada@Example.org, bob@example.org  not-an-email"),
    ]).toEqual(["ada@example.org", "bob@example.org"]);
    expect(parseAdminEmails(undefined).size).toBe(0);
  });
});

describe("instanceSettingsSchema", () => {
  it("fills defaults and refuses unknown policies", () => {
    expect(instanceSettingsSchema.parse({})).toEqual(INSTANCE_DEFAULTS);
    expect(INSTANCE_DEFAULTS).toMatchObject({
      signup: "open",
      defaultLocale: "en",
      maintenance: false,
      banner: null,
      mfaScope: "owners",
      lockoutThreshold: 10,
      lockoutMinutes: 15,
      sessionIdleMinutes: 15,
      sessionMaxHours: 12,
      passwordMinLength: 12,
    });
    expect(instanceSettingsSchema.safeParse({ signup: "maybe" }).success).toBe(
      false,
    );
  });

  it("trims a banner and refuses a long one", () => {
    expect(
      instanceSettingsSchema.parse({ maintenance: true, banner: "  Update  " }),
    ).toMatchObject({ maintenance: true, banner: "Update" });
    expect(
      instanceSettingsSchema.safeParse({ banner: "x".repeat(501) }).success,
    ).toBe(false);
  });
});

describe("the security policy (ADR 0043)", () => {
  const patch = (value: Record<string, unknown>) =>
    instanceSettingsPatchSchema.safeParse(value).success;

  it("keeps every floor", () => {
    expect(patch({ lockoutThreshold: 2 })).toBe(false);
    expect(patch({ lockoutThreshold: 3 })).toBe(true);
    expect(patch({ lockoutMinutes: 0 })).toBe(true);
    expect(patch({ lockoutMinutes: 4 })).toBe(false);
    expect(patch({ passwordMinLength: 11 })).toBe(false);
    expect(patch({ passwordMinLength: 64 })).toBe(true);
    expect(patch({ authRetentionDays: 179 })).toBe(false);
    expect(patch({ tokenMaxDays: 366 })).toBe(false);
    expect(patch({ sessionIdleMinutes: 4 })).toBe(false);
    expect(patch({ mfaScope: "nobody" })).toBe(false);
    expect(patch({ requireMfa: true })).toBe(false);
  });

  it("reads each key on its own, and carries requireMfa over", () => {
    expect(
      parseInstanceSettings({ signup: "invite", lockoutThreshold: 99 }),
    ).toMatchObject({ signup: "invite", lockoutThreshold: 10 });
    expect(parseInstanceSettings({ requireMfa: true }).mfaScope).toBe(
      "everyone",
    );
    expect(
      parseInstanceSettings({ requireMfa: true, mfaScope: "admins" }).mfaScope,
    ).toBe("admins");
    expect(parseInstanceSettings({ requireMfa: false }).mfaScope).toBe(
      "owners",
    );
  });

  it("normalizes sign-up domains", () => {
    const parsed = instanceSettingsPatchSchema.parse({
      signupDomains: [" Example.ORG ", "example.org", "mail.example.co.uk"],
    });
    expect(parsed.signupDomains).toEqual(["example.org", "mail.example.co.uk"]);
    expect(patch({ signupDomains: ["@example.org"] })).toBe(false);
    expect(patch({ signupDomains: ["localhost"] })).toBe(false);
    expect(emailDomainAllowed("ada@Example.org", ["example.org"])).toBe(true);
    expect(emailDomainAllowed("ada@sub.example.org", ["example.org"])).toBe(
      false,
    );
    expect(emailDomainAllowed("ada@example.org", [])).toBe(true);
  });

  it("tells whether an account is still locked", () => {
    const at = new Date("2026-11-09T10:00:00Z");
    const later = (minutes: number) =>
      new Date(at.getTime() + minutes * 60_000);
    expect(lockState(null, { lockoutMinutes: 15 }, false)).toEqual({
      locked: false,
    });
    expect(lockState(at, { lockoutMinutes: 15 }, false, later(14))).toEqual({
      locked: true,
      until: later(15),
    });
    expect(lockState(at, { lockoutMinutes: 15 }, false, later(15))).toEqual({
      locked: false,
    });
    // Until an administrator unlocks it, but never an administrator.
    expect(lockState(at, { lockoutMinutes: 0 }, false, later(9999))).toEqual({
      locked: true,
      until: null,
    });
    expect(
      lockState(at, { lockoutMinutes: 0 }, true, later(ADMIN_LOCK_MINUTES)),
    ).toEqual({ locked: false });
  });

  it("keeps the idle window inside the lifetime", () => {
    expect(
      sessionWindows({ sessionIdleMinutes: 15, sessionMaxHours: 12 }),
    ).toEqual({ idleMs: 900_000, maxMs: 43_200_000 });
    expect(
      sessionWindows({ sessionIdleMinutes: 480, sessionMaxHours: 1 }),
    ).toEqual({ idleMs: 3_600_000, maxMs: 3_600_000 });
  });
});

describe("more policies (ADR 0044)", () => {
  const patch = (value: Record<string, unknown>) =>
    instanceSettingsPatchSchema.safeParse(value).success;

  it("keeps to the defaults of today, and the bounds", () => {
    expect(INSTANCE_DEFAULTS).toMatchObject({
      invitations: "anyone",
      baseCreation: "everyone",
      apiTokens: "everyone",
      inactiveDays: 0,
      lockAlerts: true,
      releaseCheck: false,
    });
    expect(patch({ inactiveDays: 0 })).toBe(true);
    expect(patch({ inactiveDays: 29 })).toBe(false);
    expect(patch({ inactiveDays: 90 })).toBe(true);
    expect(patch({ baseCreation: "owners" })).toBe(false);
    expect(patch({ invitations: "domains" })).toBe(true);
  });

  it("keeps roles to the sign-up domains only when asked and when some are set", () => {
    const domains = ["example.org"];
    expect(
      memberDomainAllowed("guest@else.test", {
        invitations: "anyone",
        signupDomains: domains,
      }),
    ).toBe(true);
    expect(
      memberDomainAllowed("guest@else.test", {
        invitations: "domains",
        signupDomains: domains,
      }),
    ).toBe(false);
    expect(
      memberDomainAllowed("ada@example.org", {
        invitations: "domains",
        signupDomains: domains,
      }),
    ).toBe(true);
    expect(
      memberDomainAllowed("guest@else.test", {
        invitations: "domains",
        signupDomains: [],
      }),
    ).toBe(true);
  });

  it("warns a week before disabling, or a quarter of the delay", () => {
    const active = new Date("2026-01-01T00:00:00Z");
    expect(inactivityDates(active, { inactiveDays: 0 })).toBeNull();
    expect(inactivityDates(active, { inactiveDays: 90 })).toEqual({
      warnAt: new Date("2026-03-25T00:00:00Z"),
      disableAt: new Date("2026-04-01T00:00:00Z"),
    });
    expect(inactivityDates(active, { inactiveDays: 30 })?.warnAt).toEqual(
      new Date("2026-01-24T00:00:00Z"),
    );
  });
});
