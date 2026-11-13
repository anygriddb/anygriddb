import { describe, expect, it } from "vitest";
import { auditorMayCall } from "./auditor-rule.js";

describe("what an auditor may call", () => {
  it("lets it read, and export what the trail keeps under its name", () => {
    expect(auditorMayCall("query", "admin.users")).toBe(true);
    expect(auditorMayCall("query", "admin.groups.get")).toBe(true);
    // A read added tomorrow is one too.
    expect(auditorMayCall("query", "admin.something.new")).toBe(true);
    expect(auditorMayCall("mutation", "admin.exportAudit")).toBe(true);
    expect(auditorMayCall("mutation", "admin.exportAuthAudit")).toBe(true);
    expect(auditorMayCall("mutation", "admin.accessReport")).toBe(true);
  });

  it("refuses whatever changes, and the read that reaches a client database", () => {
    expect(auditorMayCall("mutation", "admin.updateSettings")).toBe(false);
    expect(auditorMayCall("mutation", "admin.setAuditor")).toBe(false);
    // A change added tomorrow is refused without a word here.
    expect(auditorMayCall("mutation", "admin.something.new")).toBe(false);
    expect(auditorMayCall("subscription", "admin.users")).toBe(false);
    expect(auditorMayCall("query", "admin.sources.tables")).toBe(false);
    // An export by its name alone, outside Administration, is not one.
    expect(auditorMayCall("mutation", "exportAudit")).toBe(false);
  });
});
