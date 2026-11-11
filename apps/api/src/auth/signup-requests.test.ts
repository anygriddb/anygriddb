import type { Database } from "@anygriddb/db";
import { describe, expect, it } from "vitest";
import { findSignupRequest, signupLinkUrl } from "./signup-requests.js";
import {
  accountExistsMailBody,
  signupMailBody,
  signupMailSubject,
} from "../mail-i18n.js";

describe("sign-up links", () => {
  it("points at the confirmation page of this instance", () => {
    expect(signupLinkUrl("https://grid.example.org/", "a".repeat(43))).toBe(
      `https://grid.example.org/signup/${"a".repeat(43)}`,
    );
  });

  it("refuses a malformed token without asking the database", async () => {
    const db = new Proxy({} as Database, {
      get() {
        throw new Error("the database was asked");
      },
    });
    for (const token of ["", "short", `${"a".repeat(43)}/x`, "a".repeat(44)]) {
      expect(await findSignupRequest(db, token)).toBeNull();
    }
  });

  it("says what the link does, and that ignoring it creates nothing", () => {
    const until = new Date("2026-11-12T10:00:00Z");
    const link = `https://grid.example.org/signup/${"a".repeat(43)}`;
    const en = signupMailBody("en", { link, expiresAt: until });
    expect(en).toContain(link);
    expect(en).toContain("enter the password you chose");
    expect(en).toContain("no account is created");
    const fr = signupMailBody("fr", { link, expiresAt: until });
    expect(fr).toContain("aucun compte n'est créé");
    expect(signupMailSubject("fr")).toContain("confirmer votre adresse");
    expect(
      accountExistsMailBody("en", {
        loginUrl: "https://grid.example.org/login",
      }),
    ).toContain("already has one");
  });
});
