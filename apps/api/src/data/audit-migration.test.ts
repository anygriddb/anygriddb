import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("audit migration", () => {
  it("installs the immutable audit triggers and the row status column", () => {
    const db = readFileSync(
      new URL(
        "../../../../packages/db/migrations/0003_audit_trail.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(db).toContain("FUNCTION prevent_audit_tampering()");
    expect(db).toContain("FUNCTION audit_record()");
    expect(db).toContain("FUNCTION audit_catalog()");
    expect(db).toContain("BEFORE UPDATE OR DELETE ON audit_events");
    expect(db).toContain("BEFORE UPDATE OR DELETE ON row_signatures");
    expect(db).toContain("ag_status");
    expect(db).toContain("anygrid.migrate");
    expect(db).not.toContain("anygrid.migrate', 'on', false");
  });
});
