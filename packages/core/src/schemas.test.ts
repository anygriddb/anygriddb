import { describe, expect, it } from "vitest";
import {
  importCommitInputSchema,
  moveRowsInputSchema,
  rowsReadInputSchema,
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

describe("moveRowsInputSchema", () => {
  const tableId = "11111111-1111-4111-8111-111111111111";
  const row = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";

  it("takes rows and the one row they go before or after", () => {
    expect(
      moveRowsInputSchema.parse({
        tableId,
        rowIds: [row],
        place: { before: other },
      }).place,
    ).toEqual({ before: other });
    expect(
      moveRowsInputSchema.parse({
        tableId,
        rowIds: [row],
        place: { after: other },
      }).place,
    ).toEqual({ after: other });
  });

  it("refuses a place on both sides, on none, or beside a client's key", () => {
    for (const place of [
      { before: other, after: other },
      {},
      { before: "42" },
    ]) {
      expect(
        moveRowsInputSchema.safeParse({ tableId, rowIds: [row], place })
          .success,
      ).toBe(false);
    }
    expect(
      moveRowsInputSchema.safeParse({
        tableId,
        rowIds: [],
        place: { after: other },
      }).success,
    ).toBe(false);
  });
});

describe("the time zone of a read", () => {
  it("takes what a browser reports, even a zone the server does not know", () => {
    for (const timeZone of ["Europe/Paris", "Etc/Unknown", "EST5EDT"]) {
      expect(
        rowsReadInputSchema.safeParse({ tableId: TABLE, timeZone }).success,
      ).toBe(true);
    }
  });

  it("refuses a text longer than a zone's name", () => {
    expect(
      rowsReadInputSchema.safeParse({
        tableId: TABLE,
        timeZone: "x".repeat(65),
      }).success,
    ).toBe(false);
  });
});
