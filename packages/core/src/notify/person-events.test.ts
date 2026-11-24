import { describe, expect, it } from "vitest";
import {
  EMAIL_MIGRATION_EVENTS,
  PERSON_EVENT_CATALOG,
  PERSON_EVENTS,
  personEvent,
  withRequiredChannels,
  wantsEmail,
} from "./person-events";

describe("person event catalogue", () => {
  it("names every event once", () => {
    expect(PERSON_EVENT_CATALOG.map((event) => event.id).sort()).toEqual(
      [...PERSON_EVENTS].sort(),
    );
  });

  it("keeps security and emergency notices on immediate email", () => {
    for (const id of [
      "locked",
      "password_changed",
      "factors_removed",
      "sso_linked",
      "inactive_soon",
      "inactive_disabled",
      "admin_access",
      "acting_as",
    ] as const) {
      expect(personEvent(id).required).toContain("email_immediate");
    }
  });

  it("forces required channels back onto a cleared choice", () => {
    expect(withRequiredChannels("password_changed", [])).toEqual([
      "email_immediate",
    ]);
    expect(withRequiredChannels("mention", [])).toEqual([]);
    expect(withRequiredChannels("admin_access", ["in_app"])).toEqual([
      "email_immediate",
      "in_app",
    ]);
  });

  it("migrates the old email flag onto collaborative events only", () => {
    expect(EMAIL_MIGRATION_EVENTS).toContain("mention");
    expect(EMAIL_MIGRATION_EVENTS).not.toContain("password_changed");
    expect(EMAIL_MIGRATION_EVENTS).not.toContain("admin_access");
  });

  it("detects any email channel", () => {
    expect(wantsEmail(["in_app"])).toBe(false);
    expect(wantsEmail(["email_daily"])).toBe(true);
  });
});
