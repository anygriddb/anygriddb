import { describe, expect, it } from "vitest";
import {
  ROW_STATE_KEY,
  SNAPSHOT_KEPT_VERSION,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  baseSnapshotSchema,
  claimsRowState,
  exportSnapshotJobInputSchema,
  importSnapshotJobInputSchema,
  ownSnapshotLineSchema,
  snapshotCommentSchema,
  snapshotFilename,
  snapshotLineCells,
  snapshotLineField,
  snapshotLineSchema,
  snapshotRowCount,
  snapshotRowsEntry,
  snapshotSummary,
  writeSnapshotLine,
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

  it("keeps the folders a base holds its tables in", () => {
    const [table] = minimal.tables;
    const inFolder = (folder: string) => ({
      ...minimal,
      tables: [{ ...table, folder }],
    });
    const parsed = baseSnapshotSchema.parse({
      ...inFolder("Clients"),
      // In their order, an empty one included.
      folders: [{ name: "Archive" }, { name: "Clients" }],
    });
    expect(parsed.folders?.map((folder) => folder.name)).toEqual([
      "Archive",
      "Clients",
    ]);
    expect(parsed.tables[0]?.folder).toBe("Clients");
    // A base without folders says nothing of them.
    expect(baseSnapshotSchema.parse(minimal).folders).toBeUndefined();
    // A table sits in a folder the snapshot lists, each named once.
    expect(baseSnapshotSchema.safeParse(inFolder("Clients")).success).toBe(
      false,
    );
    expect(
      baseSnapshotSchema.safeParse({
        ...inFolder("Clients"),
        folders: [{ name: "Archive" }],
      }).success,
    ).toBe(false);
    expect(
      baseSnapshotSchema.safeParse({
        ...minimal,
        folders: [{ name: "Clients" }, { name: "Clients" }],
      }).success,
    ).toBe(false);
  });

  it("keeps a base's dashboards, each widget naming its table and its view", () => {
    const [table] = minimal.tables;
    if (!table) throw new Error("no table");
    const viewed = {
      ...minimal,
      tables: [
        {
          ...table,
          views: [
            { name: "Grid", viewType: "grid" as const },
            { name: "Recent", viewType: "grid" as const },
          ],
        },
      ],
    };
    const widget = {
      title: "Contacts",
      kind: "metric" as const,
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      // The table by its key, the view by its rank among the table's.
      table: "contacts",
      view: 1,
      config: { column: "nom", fn: "count_all" },
    };
    const board = (widgets: unknown[], more: object = {}) => ({
      ...viewed,
      dashboards: [{ name: "Overview", widgets, ...more }],
    });
    const parsed = baseSnapshotSchema.parse(
      board(
        [
          widget,
          {
            ...widget,
            title: "By email",
            kind: "chart",
            view: undefined,
            config: { groupBy: "email", fn: "count_all", chartType: "bar" },
          },
          { ...widget, title: "Rows", kind: "view_embed", config: {} },
        ],
        // Two it could not hold: a client's table, a view of one person.
        { description: "The week", left: 2 },
      ),
    );
    expect(parsed.dashboards?.[0]?.widgets.map((item) => item.title)).toEqual([
      "Contacts",
      "By email",
      "Rows",
    ]);
    expect(parsed.dashboards?.[0]?.left).toBe(2);
    // A base without dashboards says nothing of them.
    expect(baseSnapshotSchema.parse(minimal).dashboards).toBeUndefined();
    // One without a widget is a dashboard still.
    expect(baseSnapshotSchema.safeParse(board([])).success).toBe(true);

    const refused = (widgets: unknown[]) =>
      baseSnapshotSchema.safeParse(board(widgets)).success;
    // A table the snapshot does not list, a view past the table's last.
    expect(refused([{ ...widget, table: "orders" }])).toBe(false);
    expect(refused([{ ...widget, view: 2 }])).toBe(false);
    // Settings its kind does not read with: a figure needs its field,
    // rows drawn need their view, and an id of another base is no key.
    expect(refused([{ ...widget, config: { fn: "count_all" } }])).toBe(false);
    expect(
      refused([{ ...widget, kind: "view_embed", view: undefined, config: {} }]),
    ).toBe(false);
    expect(
      refused([{ ...widget, config: { ...widget.config, tableId: id } }]),
    ).toBe(false);
    expect(
      refused([{ ...widget, config: { ...widget.config, viewId: id } }]),
    ).toBe(false);
    // A base names each dashboard once.
    expect(
      baseSnapshotSchema.safeParse({
        ...viewed,
        dashboards: [
          { name: "Overview", widgets: [] },
          { name: "Overview", widgets: [] },
        ],
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

  it("carries each person's own role and rules on a table", () => {
    const table = lines.tables[0];
    if (!table) throw new Error("no table");
    const access = [
      {
        email: "ada@example.com",
        role: "viewer",
        rowFilter: {
          conjunction: "and",
          conditions: [{ column: "nom", op: "is_not_empty" }],
        },
        columns: [{ column: "email", access: "hide" }],
      },
    ];
    const parsed = baseSnapshotSchema.parse({
      ...lines,
      tables: [{ ...table, access }],
    });
    expect(parsed.tables[0]?.access).toEqual(access);
    for (const wrong of [
      { ...access[0], email: "not an address" },
      { ...access[0], columns: [{ column: "email", access: "erase" }] },
      { ...access[0], role: "admin" },
    ]) {
      expect(
        baseSnapshotSchema.safeParse({
          ...lines,
          tables: [{ ...table, access: [wrong] }],
        }).success,
      ).toBe(false);
    }
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

  it("holds a line's number to what a table can go on from", () => {
    const line = (seq: string) =>
      snapshotLineSchema.safeParse({ __seq: seq, __position: "1" }).success;
    expect(line(String(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(line("9007199254740992")).toBe(false);
    expect(line("9223372036854775807")).toBe(false);
    // A copy the instance made of its own table reads what that table holds.
    expect(
      ownSnapshotLineSchema.safeParse({
        __seq: "9223372036854775807",
        __position: "1",
      }).success,
    ).toBe(true);
  });

  it("holds a line's place to what the places of new rows can go on from", () => {
    const line = (place: string) =>
      snapshotLineSchema.safeParse({ __seq: "1", __position: place }).success;
    expect(line(String(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(line(`-${String(Number.MAX_SAFE_INTEGER)}.5`)).toBe(true);
    expect(line("12.0625")).toBe(true);
    expect(line("9007199254740992")).toBe(false);
    expect(line("9223372036854775807")).toBe(false);
    expect(line("-9223372036854775807.5")).toBe(false);
    expect(line("9".repeat(5_000))).toBe(false);
    expect(
      ownSnapshotLineSchema.safeParse({
        __seq: "1",
        __position: "9223372036854775807",
      }).success,
    ).toBe(true);
  });
});

describe("a field named like a line's own keys", () => {
  it("keeps its value apart from the row's number and place", () => {
    const line = writeSnapshotLine({
      seq: "7",
      position: "1.5",
      cells: { name: "Ada", __seq: "field", __position: ["3"], __id: "kept" },
    });
    expect(line.__seq).toBe("7");
    expect(line.__position).toBe("1.5");
    expect(line.name).toBe("Ada");
    expect(line.__id).toBe("kept");
    const read = snapshotLineSchema.parse(line);
    expect(snapshotLineCells(read)).toEqual({
      name: "Ada",
      __seq: "field",
      __position: ["3"],
      __id: "kept",
    });
    expect(snapshotLineField(read, "__seq")).toBe("field");
    expect(snapshotLineField(read, "name")).toBe("Ada");
  });

  it("writes a plain line when no field is named that way", () => {
    const state = {
      status: "draft" as const,
      createdAt: "2026-03-01T08:15:30.123456Z",
      updatedAt: "2026-03-01T08:15:30.123456Z",
      createdBy: null,
      updatedBy: null,
    };
    const line = writeSnapshotLine({
      seq: "7",
      position: "1",
      cells: { name: "Ada" },
      state,
    });
    expect(line).toEqual({
      __seq: "7",
      __position: "1",
      name: "Ada",
      [ROW_STATE_KEY]: state,
    });
    expect(snapshotLineCells(line)).toEqual({ name: "Ada" });
  });

  it("refuses anything else kept apart", () => {
    expect(
      snapshotLineSchema.safeParse({
        __seq: "1",
        __position: "1",
        "@fields": { name: "Ada" },
      }).success,
    ).toBe(false);
  });
});

describe("version 4: an instance's own copy of its rows", () => {
  const state = {
    status: "locked",
    createdAt: "2026-03-01T08:15:30.123456Z",
    updatedAt: "2026-03-02T09:00:00.000001Z",
    createdBy: id,
    updatedBy: null,
  };
  const own = (rowState: unknown) =>
    ownSnapshotLineSchema.safeParse({
      __seq: "1",
      __position: "1",
      [ROW_STATE_KEY]: rowState,
    }).success;

  it("reads a row's dates, authors, and status", () => {
    expect(own(state)).toBe(true);
    expect(own({ ...state, status: "signed", updatedBy: id })).toBe(true);
  });

  it("refuses a state it cannot write back as it was", () => {
    expect(own({ ...state, status: "archived" })).toBe(false);
    expect(own({ ...state, createdAt: "yesterday" })).toBe(false);
    expect(own({ ...state, updatedAt: "2026-03-02T09:00:00Z" })).toBe(false);
    expect(own({ ...state, createdBy: "someone" })).toBe(false);
    expect(own({ ...state, extra: true })).toBe(false);
  });

  it("holds its rows in entries, as version 3 does", () => {
    const table = minimal.tables[0];
    if (!table) throw new Error("no table");
    const { rows: _rows, ...schema } = table;
    const kept = { ...minimal, version: SNAPSHOT_KEPT_VERSION };
    expect(
      baseSnapshotSchema.safeParse({
        ...kept,
        tables: [{ ...schema, rowCount: 1 }],
      }).success,
    ).toBe(true);
    expect(baseSnapshotSchema.safeParse(kept).success).toBe(false);
  });

  it("carries a table's comments, and only there", () => {
    const table = minimal.tables[0];
    if (!table) throw new Error("no table");
    const { rows: _rows, ...schema } = table;
    const kept = { ...minimal, version: SNAPSHOT_KEPT_VERSION };
    const withComments = (snapshot: object, rowCount?: number) =>
      baseSnapshotSchema.safeParse({
        ...snapshot,
        tables: [{ ...schema, ...(rowCount ? { rowCount } : {}), comments: 2 }],
      }).success;
    expect(withComments(kept, 1)).toBe(true);
    // A file a person downloads, or any other, brings none (ADR 0122).
    expect(withComments({ ...minimal, version: SNAPSHOT_VERSION }, 1)).toBe(
      false,
    );
    // Nor do they come without the rows they are on.
    expect(withComments(kept)).toBe(false);
  });

  it("reads a comment as it was, and refuses one it cannot write back", () => {
    const comment = {
      id,
      row: "12",
      parent: null,
      author: id,
      body: "Is the dose right?",
      createdAt: "2026-03-01T08:15:30.123456Z",
      updatedAt: null,
      deletedAt: null,
      resolvedAt: "2026-03-02T09:00:00.000001Z",
      resolvedBy: id,
    };
    const read = (value: object) =>
      snapshotCommentSchema.safeParse(value).success;
    expect(read(comment)).toBe(true);
    expect(read({ ...comment, parent: id, resolvedBy: null })).toBe(true);
    expect(read({ ...comment, row: "0" })).toBe(false);
    expect(read({ ...comment, author: null })).toBe(false);
    expect(read({ ...comment, author: "someone" })).toBe(false);
    expect(read({ ...comment, createdAt: "2026-03-01T08:15:30Z" })).toBe(false);
    expect(read({ ...comment, body: "x".repeat(4_001) })).toBe(false);
    expect(read({ ...comment, extra: true })).toBe(false);
  });

  it("tells a row that claims a state from a field of that name", () => {
    const line = { __seq: "1", __position: "1", __status: "signed" };
    expect(claimsRowState(line, new Set(["nom"]))).toBe(true);
    expect(claimsRowState(line, new Set(["__status"]))).toBe(false);
    expect(
      claimsRowState(
        { __seq: "1", __position: "1", [ROW_STATE_KEY]: "signed" },
        new Set(["nom"]),
      ),
    ).toBe(true);
    expect(
      claimsRowState({ __seq: "1", __position: "1", nom: "Ada" }, new Set()),
    ).toBe(false);
  });
});

describe("snapshotSummary", () => {
  it("counts what a file holds, its members without the person importing it", () => {
    const parsed = baseSnapshotSchema.parse({
      ...minimal,
      members: [
        { email: "ada@example.com", role: "owner" },
        { email: "bob@example.com", role: "editor" },
      ],
      dashboards: [{ name: "Overview", widgets: [] }],
    });
    // Ada owns the base she makes, whatever the file says of her: only
    // Bob has a role to be given back.
    expect(snapshotSummary(parsed, "Ada@Example.com")).toEqual({
      name: "Demo",
      tables: 1,
      dashboards: 1,
      rows: 1,
      files: 0,
      members: 1,
    });
    // Someone the file does not name can give every member theirs.
    expect(snapshotSummary(parsed, "carol@example.com").members).toBe(2);
    // A file that names its importer alone has nobody to give a role to.
    expect(
      snapshotSummary(
        { ...parsed, members: [{ email: "ada@example.com", role: "owner" }] },
        "ada@example.com",
      ).members,
    ).toBe(0);
    expect(
      snapshotSummary(baseSnapshotSchema.parse(minimal), "x").members,
    ).toBe(0);
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
