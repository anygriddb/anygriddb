import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  baseSnapshotSchema,
  exportSnapshotJobInputSchema,
  importSnapshotJobInputSchema,
  snapshotFilename,
  snapshotLineSchema,
  snapshotRowCount,
  snapshotRowsEntry,
} from "./snapshot";

const id = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";

/** A version 2 snapshot: its rows inside the JSON. */
const minimal = {
  kind: SNAPSHOT_KIND,
  version: 2,
  base: { name: "Demo" },
  tables: [
    {
      key: "contacts",
      name: "Contacts",
      columns: [
        { label: "Nom", fieldType: "text" as const },
        { label: "Email", fieldType: "email" as const },
      ],
      views: [],
      rows: [{ __id: "r1", nom: "Ada", email: "ada@example.com" }],
    },
  ],
  links: [],
  computed: [],
};

describe("baseSnapshotSchema", () => {
  it("accepts a minimal portable base", () => {
    const parsed = baseSnapshotSchema.parse(minimal);
    expect(parsed.tables[0]?.key).toBe("contacts");
    expect(parsed.tables[0]?.rows).toHaveLength(1);
  });

  it("refuses a wrong kind or version", () => {
    expect(
      baseSnapshotSchema.safeParse({ ...minimal, kind: "other" }).success,
    ).toBe(false);
    expect(
      baseSnapshotSchema.safeParse({ ...minimal, version: 4 }).success,
    ).toBe(false);
    // Files written before members and attachments still import.
    expect(
      baseSnapshotSchema.safeParse({ ...minimal, version: 1 }).success,
    ).toBe(true);
  });

  it("carries members, people by email, and attachment files (version 2)", () => {
    const table = minimal.tables[0];
    if (!table) throw new Error("no table");
    const withFiles = {
      ...minimal,
      version: 2,
      members: [{ email: "ada@example.com", role: "editor" }],
      files: [
        { id: "attA", name: "plan.pdf", size: 12, sha256: "a".repeat(64) },
      ],
      tables: [
        {
          ...table,
          rows: [
            {
              __id: "r1",
              docs: [{ file: "attA", name: "plan.pdf" }],
              who: ["ada@example.com"],
            },
          ],
        },
      ],
    };
    expect(baseSnapshotSchema.safeParse(withFiles).success).toBe(true);
    expect(
      baseSnapshotSchema.safeParse({
        ...withFiles,
        files: [{ id: "../x", name: "x", size: 1, sha256: "a".repeat(64) }],
      }).success,
    ).toBe(false);
    expect(
      baseSnapshotSchema.safeParse({
        ...withFiles,
        members: [{ email: "ada@example.com", role: "admin" }],
      }).success,
    ).toBe(false);
  });

  it("refuses unknown keys and empty tables", () => {
    expect(
      baseSnapshotSchema.safeParse({ ...minimal, extra: true }).success,
    ).toBe(false);
    expect(
      baseSnapshotSchema.safeParse({ ...minimal, tables: [] }).success,
    ).toBe(false);
  });
});

describe("version 3: rows as lines of their own entry", () => {
  const lines = {
    ...minimal,
    version: SNAPSHOT_VERSION,
    tables: minimal.tables.map(({ rows: _rows, ...table }) => ({
      ...table,
      rowCount: 2,
    })),
    links: [
      {
        from: "contacts",
        to: "contacts",
        name: "manager",
        label: "Manager",
        inverseLabel: "Reports",
        multiple: false,
      },
    ],
  };

  it("counts the rows its entries hold, and names each entry", () => {
    const parsed = baseSnapshotSchema.parse(lines);
    expect(snapshotRowCount(parsed)).toBe(2);
    expect(snapshotRowCount(minimal)).toBe(1);
    expect(snapshotRowsEntry("contacts")).toBe("rows/contacts.ndjson");
  });

  it("refuses rows or link pairs inside its JSON, and a count in version 2", () => {
    const table = lines.tables[0];
    if (!table) throw new Error("no table");
    expect(
      baseSnapshotSchema.safeParse({
        ...lines,
        tables: [{ ...table, rows: [{ __id: "r1" }] }],
      }).success,
    ).toBe(false);
    expect(
      baseSnapshotSchema.safeParse({
        ...lines,
        links: lines.links.map((link) => ({
          ...link,
          links: [{ from: "r1", to: ["r2"] }],
        })),
      }).success,
    ).toBe(false);
    expect(
      baseSnapshotSchema.safeParse({
        ...minimal,
        tables: [{ ...table, rowCount: 2 }],
      }).success,
    ).toBe(false);
  });

  it("reads a line with its number, its place, its cells, and its links", () => {
    const line = snapshotLineSchema.parse({
      __seq: "12",
      __position: "-3.5",
      nom: "Ada",
      manager: ["7"],
      docs: [{ file: "attA", name: "plan.pdf" }],
    });
    expect(line.__seq).toBe("12");
  });

  it("refuses a line without a number or a place, or with a bad one", () => {
    expect(snapshotLineSchema.safeParse({ __position: "1" }).success).toBe(
      false,
    );
    expect(
      snapshotLineSchema.safeParse({ __seq: "0", __position: "1" }).success,
    ).toBe(false);
    expect(
      snapshotLineSchema.safeParse({ __seq: "1", __position: "one" }).success,
    ).toBe(false);
    expect(
      snapshotLineSchema.safeParse({
        __seq: "1",
        __position: "1",
        nom: { nested: true },
      }).success,
    ).toBe(false);
  });
});

describe("snapshot job inputs", () => {
  it("defaults export to include data", () => {
    expect(exportSnapshotJobInputSchema.parse({ baseId: id }).withData).toBe(
      true,
    );
  });

  it("requires a staged snapshot id for import", () => {
    expect(
      importSnapshotJobInputSchema.safeParse({
        snapshotId: "a".repeat(32),
        name: "Copie",
      }).success,
    ).toBe(true);
    expect(
      importSnapshotJobInputSchema.safeParse({ snapshotId: "short" }).success,
    ).toBe(false);
  });
});

describe("snapshotFilename", () => {
  it("keeps a readable ascii name", () => {
    expect(snapshotFilename("Clients & Prospects")).toBe(
      "Clients_Prospects.anygriddb.json",
    );
    expect(snapshotFilename("!!!")).toBe("base.anygriddb.json");
    expect(snapshotFilename("Clients", true)).toBe("Clients.anygriddb.zip");
  });
});
