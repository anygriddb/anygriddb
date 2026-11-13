import { describe, expect, it } from "vitest";
import {
  importCommitInputSchema,
  TABLE_ACTIVITY_MAX,
  tableActivityInputSchema,
} from "./schemas";

const TABLE = "11111111-1111-4111-8111-111111111111";
const IMPORT = "abcdefghijklmnopqrstuvwxyz012345";

describe("importCommitInputSchema", () => {
  it("accepts a mapping into an existing table with an upsert key", () => {
    const parsed = importCommitInputSchema.safeParse({
      importId: IMPORT,
      target: { kind: "existing", tableId: TABLE },
      mapping: [
        { source: 0, column: "ref" },
        { source: 1, create: { label: "Prix", fieldType: "number" } },
      ],
      upsertSource: 0,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.addOptions).toBe(true);
  });

  it("refuses repeated sources, existing columns in a new table, and a stray key", () => {
    const base = {
      importId: IMPORT,
      target: { kind: "existing", tableId: TABLE },
    };
    expect(
      importCommitInputSchema.safeParse({
        ...base,
        mapping: [
          { source: 0, column: "a" },
          { source: 0, column: "b" },
        ],
      }).success,
    ).toBe(false);
    expect(
      importCommitInputSchema.safeParse({
        importId: IMPORT,
        target: { kind: "new", baseId: TABLE, name: "T" },
        mapping: [{ source: 0, column: "a" }],
      }).success,
    ).toBe(false);
    expect(
      importCommitInputSchema.safeParse({
        ...base,
        mapping: [{ source: 0, column: "a" }],
        upsertSource: 3,
      }).success,
    ).toBe(false);
    expect(
      importCommitInputSchema.safeParse({
        ...base,
        mapping: [
          { source: 0, column: "a", create: { label: "A", fieldType: "text" } },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("tableActivityInputSchema", () => {
  it("accepts the tables a home page lists", () => {
    const tableIds = Array.from({ length: TABLE_ACTIVITY_MAX }, () => TABLE);
    expect(tableActivityInputSchema.safeParse({ tableIds }).success).toBe(true);
  });

  it("refuses more tables than a home page lists, or none", () => {
    const tableIds = Array.from(
      { length: TABLE_ACTIVITY_MAX + 1 },
      () => TABLE,
    );
    expect(tableActivityInputSchema.safeParse({ tableIds }).success).toBe(
      false,
    );
    expect(tableActivityInputSchema.safeParse({ tableIds: [] }).success).toBe(
      false,
    );
  });
});
