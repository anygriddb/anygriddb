import { describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { DELEGATED_PROCEDURES, delegatedMayCall } from "./delegation-rule.js";

describe("the parts of Administration given apart (ADR 0126)", () => {
  it("names only procedures the router has", () => {
    const known = new Set(Object.keys(appRouter._def.procedures));
    expect(
      Object.keys(DELEGATED_PROCEDURES).filter((path) => !known.has(path)),
    ).toEqual([]);
  });

  it("never opens what gives access, erases, acts as someone or takes data out", () => {
    for (const path of [
      "admin.setAdmin",
      "admin.setSupport",
      "admin.setAuditor",
      "admin.setInstanceRole",
      "admin.setBaseRole",
      "admin.removeBaseRole",
      "admin.groups.setBaseRole",
      "admin.people.add",
      "admin.erase",
      "admin.eraseInfo",
      "admin.startActing",
      "admin.handOver",
      "admin.accountData",
      "admin.exportAccountData",
      "admin.revokeAllTokens",
      "admin.endOtherSessions",
      "admin.endPasswordAccess",
      "admin.updateSettings",
      "admin.settings",
      "admin.authAudit",
      "admin.audit",
    ]) {
      expect(DELEGATED_PROCEDURES[path], path).toBeUndefined();
      expect(
        delegatedMayCall(["account_manager", "source_manager"], path),
        path,
      ).toBe(false);
    }
  });

  it("opens each part to its own role alone", () => {
    expect(delegatedMayCall(["account_manager"], "admin.createAccount")).toBe(
      true,
    );
    expect(delegatedMayCall(["account_manager"], "admin.groups.create")).toBe(
      true,
    );
    expect(delegatedMayCall(["account_manager"], "admin.sources.list")).toBe(
      false,
    );
    expect(delegatedMayCall(["source_manager"], "admin.sources.expose")).toBe(
      true,
    );
    expect(delegatedMayCall(["source_manager"], "admin.users")).toBe(false);
    expect(delegatedMayCall([], "admin.users")).toBe(false);
    // Both give the proof their changes ask for.
    for (const role of ["account_manager", "source_manager"] as const) {
      expect(delegatedMayCall([role], "admin.stepUp")).toBe(true);
    }
  });
});
