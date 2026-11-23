/**
 * A field converted to another type, against a real database: each pair
 * keeps what fits and empties what does not, the preview says how many
 * before anything changes, what depends on the field is named and keeps
 * working or says it cannot, and a large table is converted in the
 * background, by batches, read-only meanwhile, with a short switch.
 */
import { randomBytes } from "node:crypto";
import {
  buildConversionGuard,
  buildConversionMarks,
  buildConversionTempColumn,
  convertCell,
  type FieldType,
  parseColumnConfig,
} from "@anygriddb/core";
import { runStatement, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { withAudit } from "../data/audit-context.js";
import { loadEngine } from "../data/engine.js";
import { insertRows, updateRows } from "../data/rows.js";
import { previewConversion } from "../data/schema-ops.js";
import type { Env } from "../env.js";
import { DiskStore } from "../files/index.js";
import { jobRunners } from "../job-runners.js";
import {
  claimJob,
  recoverJobs,
  runJob,
  runQueuedJob,
  type JobRow,
} from "../jobs.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { findLiveTable } from "../services/rows.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const PARIS = "Europe/Paris";
const NEW_YORK = "America/New_York";

type StoredType = Exclude<
  FieldType,
  "relation_one_to_many" | "relation_many_to_many" | "lookup" | "rollup"
>;

type Column = {
  name: string;
  label: string;
  fieldType: StoredType;
  config?: Record<string, unknown>;
};

const field = (
  name: string,
  fieldType: StoredType,
  config?: Record<string, unknown>,
): Column => ({
  name,
  label: name,
  fieldType,
  ...(config ? { config } : {}),
});

const options = (...names: string[]) =>
  names.map((name) => ({ name, color: "gray" }));

describe("a field converted", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const visitor = browser();
  let ownerId = "";
  let baseId = "";
  let runners: ReturnType<typeof jobRunners>;
  let queue: Parameters<typeof runJob>[0];

  beforeAll(async () => {
    const created = await createTestDatabase("conversions");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    ownerId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `owner-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await owner.call().catalog.createBase({ name: "Fields" })).id;
    const bus = recordingBus().bus;
    runners = jobRunners({
      db,
      bus,
      files: {} as DiskStore,
      log: () => undefined,
    });
    queue = { db, bus, log: () => undefined };
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  let made = 0;
  /** A table with a text field that names its rows, and the fields asked. */
  async function tableWith(
    columns: Column[],
    rows: Array<Record<string, unknown>> = [],
  ): Promise<{ id: string; physical: string; ids: string[] }> {
    made += 1;
    const { id } = await owner.call().catalog.createTable({
      baseId,
      name: `Table ${String(made)}`,
      columns: [field("title", "text"), ...columns],
    });
    const { physicalName: physical } = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const ids =
      rows.length === 0
        ? []
        : (
            await owner.call().rows.insertMany({
              tableId: id,
              rows: rows.map((row, index) => ({
                title: `row ${String(index)}`,
                ...row,
              })),
            })
          ).ids;
    return { id, physical, ids };
  }

  /** What PostgreSQL holds, in row order, spelled by PostgreSQL. */
  async function stored(
    physical: string,
    column: string,
  ): Promise<Array<string | null>> {
    const rows = await runStatement(db, {
      text: `select "${column}"::text as "value" from "${physical}" order by "ag_seq"`,
      values: [],
    });
    return rows.map((row) => row.value as string | null);
  }

  const convert = (
    tableId: string,
    name: string,
    fieldType: FieldType,
    extra: { timeZone?: string; config?: Record<string, unknown> } = {},
  ) =>
    owner.call().catalog.updateColumn({ tableId, name, fieldType, ...extra });

  const preview = (
    tableId: string,
    name: string,
    fieldType: FieldType,
    extra: { timeZone?: string; config?: Record<string, unknown> } = {},
  ) =>
    owner
      .call()
      .catalog.previewConversion({ tableId, name, fieldType, ...extra });

  describe("every pair of types", () => {
    const TYPES: StoredType[] = [
      "text",
      "long_text",
      "email",
      "url",
      "phone",
      "color",
      "place",
      "json",
      "single_select",
      "multi_select",
      "number",
      "rating",
      "duration",
      "boolean",
      "date",
      "datetime",
    ];
    const NAMES = ["abc", "12", "Dupont, Marie", "a", "b", "true"];
    const TEXTS = [
      "true",
      "non",
      "abc",
      "12",
      "7.5",
      "2024-02-29",
      "2024-02-29T13:45:30Z",
      "a@example.org",
      "http://[::1]/",
      "http://1.2.3/",
      "https://пример.рф/",
      "javascript:alert(1)",
      "+33 1 23 45",
      "#abc",
      "48,8566; 2,3522",
      '{"a":1}',
      '{"a":1e999999}',
      "a, b",
      "Dupont, Marie",
      "x".repeat(5000),
    ];
    const SAMPLES: Partial<Record<StoredType, readonly string[]>> = {
      number: ["0", "4", "7.5", "-5", "9007199254740993"],
      rating: ["0", "4"],
      duration: ["90.5", "3600"],
      boolean: ["true", "false"],
      date: ["2024-02-29"],
      datetime: ["2024-02-29T13:45:30.123456Z"],
      json: ['{"a": 1}', "[1, 2]"],
      multi_select: ["{a}", "{a,b}", '{"Dupont, Marie"}'],
      email: ["a@example.org"],
      url: ["http://[::1]/", "https://example.org"],
      phone: ["+33 1 23 45"],
      color: ["#aabbcc"],
      place: ["48.8566,2.3522"],
      single_select: ["a", "Dupont, Marie"],
    };

    it("holds in the database what the rule says, and never raises", async () => {
      const options = NAMES.map((name) => ({ name, color: "gray" }));
      const wrong: string[] = [];
      for (const from of TYPES) {
        const samples = SAMPLES[from] ?? TEXTS;
        const listConfig =
          from === "single_select" || from === "multi_select"
            ? { options }
            : undefined;
        for (const to of TYPES) {
          if (from === to) continue;
          const { id, physical } = await tableWith([
            field("v", from, listConfig),
          ]);
          await withAudit(
            db,
            { userId: ownerId, tableId: id, source: "web" },
            async (tx) => {
              for (const sample of samples) {
                await runStatement(tx, {
                  text: `insert into "${physical}" ("v") values ($1)`,
                  values: [sample],
                });
              }
            },
          );
          const read = await runStatement(db, {
            text: `select "v" as "raw", "v"::text as "spelled", ${from === "number" || from === "rating" || from === "duration" ? `trim_scale("v")::text` : from === "date" ? `to_char("v", 'YYYY-MM-DD')` : from === "datetime" ? `to_char("v" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : `"v"::text`} as "text" from "${physical}" order by "ag_seq"`,
            values: [],
          });
          const config =
            to === "single_select" || to === "multi_select"
              ? { options }
              : undefined;
          await convert(id, "v", to, {
            timeZone: PARIS,
            ...(config ? { config } : {}),
          });
          const kept = await stored(physical, "v");
          read.forEach((row, index) => {
            const raw = row.raw as string | boolean | string[];
            const given =
              typeof raw === "boolean" || from === "multi_select"
                ? raw
                : (row.text as string);
            const rule = convertCell(
              from,
              {
                fieldType: to,
                config: parseColumnConfig(to, config ?? {}),
              },
              from === "datetime" && to === "date"
                ? String(row.text).slice(0, 10)
                : given,
              PARIS,
            );
            const fits =
              rule !== undefined &&
              rule !== null &&
              // A document past what jsonb holds passes a parser, not the type.
              !(to === "json" && String(rule).includes("e999999"));
            if (fits !== (kept[index] !== null)) {
              wrong.push(`${from} -> ${to}: ${String(given).slice(0, 30)}`);
            }
          });
        }
      }
      expect(wrong).toEqual([]);
    }, 240_000);
  });

  describe("to a checkbox", () => {
    const yes = ["true", "on", "✓", "oui"];
    const no = ["off", "non"];
    const neither = ["maybe", "abc", "2024-02-29"];

    it("reads the words a cell reads, counts the rest as lost, and keeps them out", async () => {
      const values = [...yes, ...no, ...neither];
      const { id, physical } = await tableWith(
        [field("v", "text")],
        values.map((v) => ({ v })),
      );
      const before = await preview(id, "v", "boolean");
      expect(before).toMatchObject({ total: 9, lost: 3 });
      await convert(id, "v", "boolean");
      expect(await stored(physical, "v")).toEqual([
        ...yes.map(() => "true"),
        ...no.map(() => "false"),
        ...neither.map(() => null),
      ]);
    });

    it("does not read a date or a document as false", async () => {
      const { id, physical } = await tableWith(
        [field("d", "date"), field("j", "json")],
        [{ d: "2024-02-29", j: '{"a":1}' }],
      );
      expect(await preview(id, "d", "boolean")).toMatchObject({ lost: 1 });
      await convert(id, "d", "boolean");
      await convert(id, "j", "boolean");
      expect(await stored(physical, "d")).toEqual([null]);
      expect(await stored(physical, "j")).toEqual([null]);
    });
  });

  describe("between a day and an instant", () => {
    it("takes the day the person converting sees, and says in which zone", async () => {
      const { id, physical } = await tableWith(
        [field("v", "datetime")],
        [{ v: "2024-03-01T00:30:00+01:00" }],
      );
      const before = await preview(id, "v", "date", { timeZone: PARIS });
      expect(before).toMatchObject({ total: 1, lost: 0, timeZone: PARIS });
      expect(before.samples[0]?.after).toBe("2024-03-01");
      await convert(id, "v", "date", { timeZone: PARIS });
      expect(await stored(physical, "v")).toEqual(["2024-03-01"]);
    });

    it("keeps a day on that day for the person converting", async () => {
      const { id, physical } = await tableWith(
        [field("v", "date")],
        [{ v: "2024-02-29" }],
      );
      await convert(id, "v", "datetime", { timeZone: NEW_YORK });
      const seen = await runStatement(db, {
        text: `select to_char("v" at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as "value" from "${physical}"`,
        values: [],
      });
      expect(seen[0]?.value).toBe("2024-02-29 00:00");
    });

    it("refuses a zone that is none, and a conversion without a zone", async () => {
      const { id, physical } = await tableWith(
        [field("v", "date")],
        [{ v: "2024-02-29" }],
      );
      expect(
        await errorCode(
          convert(id, "v", "datetime", { timeZone: "Mars/Base" }),
        ),
      ).toBe("invalid_time_zone");
      expect(await errorCode(convert(id, "v", "datetime"))).toBe(
        "conversion_needs_time_zone",
      );
      expect(await stored(physical, "v")).toEqual(["2024-02-29"]);
    });
  });

  describe("a text to a date", () => {
    it("takes a whole date or date and time, and nothing that only starts like one", async () => {
      const good = ["2024-02-29", "2024-02-29T13:45:30Z"];
      const bad = [
        "2024-02-29 réunion annulée",
        "2024-02-29T25:00:00",
        "2024-02-30",
      ];
      const { id, physical } = await tableWith(
        [field("v", "text")],
        [...good, ...bad].map((v) => ({ v })),
      );
      expect(await preview(id, "v", "date")).toMatchObject({
        total: 5,
        lost: 3,
      });
      await convert(id, "v", "date");
      expect(await stored(physical, "v")).toEqual([
        "2024-02-29",
        "2024-02-29",
        null,
        null,
        null,
      ]);
    });
  });

  describe("to a multiple select", () => {
    it("keeps a single select's value whole", async () => {
      const { id, physical } = await tableWith(
        [
          field("v", "single_select", {
            options: options("Dupont, Marie", "Autre"),
          }),
        ],
        [{ v: "Dupont, Marie" }],
      );
      expect(await preview(id, "v", "multi_select")).toMatchObject({
        lost: 0,
        rewritten: 0,
      });
      await convert(id, "v", "multi_select");
      expect(await stored(physical, "v")).toEqual(['{"Dupont, Marie"}']);
    });

    it("splits a text in the order it is written, once each, among the options", async () => {
      const { id, physical } = await tableWith(
        [field("v", "text")],
        [{ v: "b, a, b" }],
      );
      expect(await preview(id, "v", "multi_select")).toMatchObject({
        lost: 0,
        rewritten: 1,
      });
      await convert(id, "v", "multi_select");
      expect(await stored(physical, "v")).toEqual(["{b,a}"]);
      const column = await db
        .selectFrom("dataColumns")
        .select("config")
        .where("tableId", "=", id)
        .where("name", "=", "v")
        .executeTakeFirstOrThrow();
      const names = (
        column.config as { options: Array<{ name: string }> }
      ).options.map((option) => option.name);
      expect(names.sort()).toEqual(["a", "b"]);
    });

    it("empties a cell a value of which is not an option", async () => {
      const { id, physical } = await tableWith(
        [field("v", "text")],
        [{ v: "a, z" }, { v: "a" }],
      );
      const config = { options: options("a") };
      expect(await preview(id, "v", "multi_select", { config })).toMatchObject({
        total: 2,
        lost: 1,
      });
      await convert(id, "v", "multi_select", { config });
      expect(await stored(physical, "v")).toEqual([null, "{a}"]);
    });
  });

  describe("an instant to a text", () => {
    it("keeps fractions of a second, and writes none where there are none", async () => {
      const { id, physical } = await tableWith(
        [field("v", "datetime")],
        [
          { v: "2024-02-29T13:45:30.123456Z" },
          { v: "2024-02-29T13:45:30Z" },
          { v: "2024-02-29T13:45:30.5Z" },
        ],
      );
      await convert(id, "v", "text");
      expect(await stored(physical, "v")).toEqual([
        "2024-02-29T13:45:30.123456Z",
        "2024-02-29T13:45:30Z",
        "2024-02-29T13:45:30.5Z",
      ]);
      await convert(id, "v", "datetime", { timeZone: PARIS });
      const back = await runStatement(db, {
        text: `select to_char("v" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "value" from "${physical}" order by "ag_seq"`,
        values: [],
      });
      expect(back.map((row) => row.value)).toEqual([
        "2024-02-29T13:45:30.123456",
        "2024-02-29T13:45:30.000000",
        "2024-02-29T13:45:30.500000",
      ]);
    });
  });

  describe("to a type that refuses some values", () => {
    it("empties and counts what the new field would refuse", async () => {
      const { id, physical } = await tableWith(
        [field("u", "text"), field("r", "number"), field("l", "long_text")],
        [
          { u: "https://example.org", r: "4", l: "short" },
          { u: "javascript:alert(1)", r: "7.5", l: "z".repeat(5000) },
          { u: "not a link", r: "-5", l: null },
        ],
      );
      expect(await preview(id, "u", "url")).toMatchObject({
        total: 3,
        lost: 2,
      });
      expect(await preview(id, "r", "rating")).toMatchObject({
        total: 3,
        lost: 2,
      });
      expect(await preview(id, "l", "text")).toMatchObject({
        total: 2,
        lost: 1,
      });
      await convert(id, "u", "url");
      await convert(id, "r", "rating");
      await convert(id, "l", "text");
      expect(await stored(physical, "u")).toEqual([
        "https://example.org",
        null,
        null,
      ]);
      expect(await stored(physical, "r")).toEqual(["4", null, null]);
      expect(await stored(physical, "l")).toEqual(["short", null, null]);
    });

    it("keeps no cell outside the options when a text holds too many values", async () => {
      const values = Array.from({ length: 300 }, (_, index) => ({
        v: `value ${String(index).padStart(4, "0")}`,
      }));
      const { id, physical } = await tableWith([field("v", "text")], values);
      expect(await preview(id, "v", "single_select")).toMatchObject({
        total: 300,
        lost: 100,
      });
      await convert(id, "v", "single_select");
      const kept = await stored(physical, "v");
      expect(kept.filter((value) => value === null)).toHaveLength(100);
      const column = await db
        .selectFrom("dataColumns")
        .select("config")
        .where("tableId", "=", id)
        .where("name", "=", "v")
        .executeTakeFirstOrThrow();
      const names = new Set(
        (column.config as { options: Array<{ name: string }> }).options.map(
          (option) => option.name,
        ),
      );
      expect(names.size).toBe(200);
      expect(kept.every((value) => value === null || names.has(value))).toBe(
        true,
      );
    });

    it("keeps from a duration and a rating only what reads back the same", async () => {
      const { id, physical } = await tableWith(
        [field("n", "number"), field("t", "text"), field("r", "number")],
        [
          { n: "9007199254740993", t: "1e400", r: "9007199254740993" },
          { n: "90.5", t: "3600", r: "3" },
        ],
      );
      await convert(id, "n", "duration");
      await convert(id, "t", "duration");
      await convert(id, "r", "rating");
      expect(await stored(physical, "n")).toEqual([null, "90.5"]);
      expect(await stored(physical, "t")).toEqual([null, "3600"]);
      expect(await stored(physical, "r")).toEqual([null, "3"]);
    });
  });

  describe("a row in the trash", () => {
    it("comes back after a conversion its value does not fit, emptied and counted", async () => {
      for (const [from, to, value, timeZone] of [
        ["text", "number", "abc"],
        ["text", "date", "abc"],
        ["text", "boolean", "abc"],
        ["number", "date", "12"],
        ["date", "number", "2024-02-29"],
        ["json", "number", '{"a": 1}'],
      ] as Array<[StoredType, FieldType, string, string?]>) {
        const { id, physical, ids } = await tableWith(
          [field("v", from)],
          [{ v: value }, { v: value }],
        );
        await owner
          .call()
          .rows.deleteMany({ tableId: id, rowIds: [ids[1] ?? ""] });
        await convert(id, "v", to, timeZone ? { timeZone } : {});
        const back = await owner
          .call()
          .rows.restore({ tableId: id, rowIds: [ids[1] ?? ""] });
        expect([from, to, back.valuesCleared]).toEqual([from, to, 1]);
        expect(await stored(physical, "v")).toEqual([null, null]);
      }
    });

    it("reads a value by the field's own settings", async () => {
      const { id, physical, ids } = await tableWith(
        [field("v", "rating", { ratingMax: 10 })],
        [{ v: 8 }],
      );
      await owner
        .call()
        .rows.deleteMany({ tableId: id, rowIds: [ids[0] ?? ""] });
      const back = await owner
        .call()
        .rows.restore({ tableId: id, rowIds: [ids[0] ?? ""] });
      expect(back.valuesCleared).toBe(0);
      expect(await stored(physical, "v")).toEqual(["8"]);
    });

    it("keeps what still fits, flattens a list into a text, and takes a mixed batch", async () => {
      const number = await tableWith(
        [field("v", "text")],
        [{ v: "12" }, { v: "abc" }, { v: "keep" }],
      );
      await owner.call().rows.deleteMany({
        tableId: number.id,
        rowIds: [number.ids[0] ?? "", number.ids[1] ?? ""],
      });
      await convert(number.id, "v", "number");
      const back = await owner.call().rows.restore({
        tableId: number.id,
        rowIds: [number.ids[0] ?? "", number.ids[1] ?? ""],
      });
      expect(back.ids).toHaveLength(2);
      expect(back.valuesCleared).toBe(1);
      expect(await stored(number.physical, "v")).toEqual(["12", null, null]);

      const list = await tableWith(
        [field("v", "multi_select", { options: options("A") })],
        [{ v: ["A"] }, { v: ["A"] }],
      );
      await owner
        .call()
        .rows.deleteMany({ tableId: list.id, rowIds: [list.ids[1] ?? ""] });
      await convert(list.id, "v", "text");
      const listed = await owner
        .call()
        .rows.restore({ tableId: list.id, rowIds: [list.ids[1] ?? ""] });
      expect(listed.valuesCleared).toBe(0);
      expect(await stored(list.physical, "v")).toEqual(["A", "A"]);
    });
  });

  describe("what depends on the field", () => {
    const above = {
      conjunction: "and" as const,
      conditions: [{ column: "n", op: "gt" as const, value: 1 }],
    };

    it("names the view whose filter stops fitting, and shows no rows in it, in the app or by its link", async () => {
      const { id } = await tableWith(
        [field("n", "number")],
        [{ n: "2" }, { n: "3" }],
      );
      const view = await owner
        .call()
        .catalog.createView({ tableId: id, name: "Above", viewType: "grid" });
      await owner.call().catalog.updateView({
        viewId: view.id,
        config: { filter: above },
      });
      const plain = await owner
        .call()
        .catalog.createView({ tableId: id, name: "All", viewType: "grid" });
      const { token } = await owner
        .call()
        .catalog.createShare({ viewId: view.id });
      const before = await preview(id, "n", "text");
      expect(before.views.map((item) => item.name)).toEqual(["Above"]);

      await convert(id, "n", "text");

      const read = await owner
        .call()
        .rows.read({ tableId: id, viewId: view.id, limit: 100 });
      expect(read.rows).toEqual([]);
      expect(read.viewFilterBroken).toBe(true);
      const other = await owner
        .call()
        .rows.read({ tableId: id, viewId: plain.id, limit: 100 });
      expect(other.rows).toHaveLength(2);
      expect(other.viewFilterBroken).toBeUndefined();
      // A public link shows no more rows than it did: it says it cannot read.
      expect(
        await errorCode(visitor.call().share.rows({ token, limit: 100 })),
      ).toBe("invalid_filter");
    });

    it("names neither another person's own view nor a field of a table they cannot read", async () => {
      const target = await tableWith([field("n", "number")], [{ n: "2" }]);
      const hidden = await tableWith([], [{}]);
      await owner.call().catalog.addRelation({
        tableId: hidden.id,
        name: "link",
        kind: "many_to_many",
        targetTableId: target.id,
      });
      await owner.call().catalog.addRollup({
        tableId: hidden.id,
        name: "secret_total",
        label: "Secret total",
        relation: "link",
        target: "n",
        fn: "sum",
      });
      const kept = await db
        .insertInto("views")
        .values({
          tableId: target.id,
          name: "Private view",
          viewType: "grid",
          position: 9,
          ownerId: (
            await db
              .insertInto("users")
              .values({
                email: `other-${suffix}@example.org`,
                displayName: "Other",
              })
              .returning("id")
              .executeTakeFirstOrThrow()
          ).id,
          config: { filter: above },
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const table = await findLiveTable(db, target.id);
      if (!table) throw new Error("no table");
      const seen = await previewConversion(db, table, "n", "text", {
        viewer: { userId: ownerId, canRead: (id) => id === target.id },
      });
      expect(seen.views.map((view) => view.id)).not.toContain(kept.id);
      expect(seen.fields).toEqual([]);
      expect(seen.fieldsElsewhere).toBe(1);
    });

    it("keeps a filter that still fits", async () => {
      const { id } = await tableWith(
        [field("n", "number")],
        [{ n: "2" }, { n: "3" }],
      );
      const view = await owner
        .call()
        .catalog.createView({ tableId: id, name: "Above", viewType: "grid" });
      await owner.call().catalog.updateView({
        viewId: view.id,
        config: { filter: above },
      });
      const before = await preview(id, "n", "duration");
      expect(before.views).toEqual([]);
      await convert(id, "n", "duration");
      const read = await owner
        .call()
        .rows.read({ tableId: id, viewId: view.id, limit: 100 });
      expect(read.rows).toHaveLength(2);
    });

    it("names the rollup a conversion stops, which then says so in its cell", async () => {
      const target = await tableWith(
        [field("n", "number")],
        [{ n: "2" }, { n: "3" }],
      );
      const holder = await tableWith([], [{}]);
      await owner.call().catalog.addRelation({
        tableId: holder.id,
        name: "link",
        kind: "many_to_many",
        targetTableId: target.id,
      });
      await owner.call().rows.setLinks({
        tableId: holder.id,
        rowId: holder.ids[0] ?? "",
        column: "link",
        targetIds: target.ids,
      });
      await owner.call().catalog.addRollup({
        tableId: holder.id,
        name: "total",
        relation: "link",
        target: "n",
        fn: "sum",
      });
      const row = async () =>
        (
          await owner
            .call()
            .rows.get({ tableId: holder.id, rowIds: [holder.ids[0] ?? ""] })
        ).rows[0];
      expect((await row())?.total).toBe("5");

      const before = await preview(target.id, "n", "text");
      expect(before.fields.map((item) => item.name)).toContain("total");

      await convert(target.id, "n", "text");

      const after = await row();
      expect(after?.total ?? null).toBeNull();
      expect(after?.title).toBe("row 0");
      const catalog = await owner.call().catalog.list();
      const column = catalog
        .flatMap((base) => base.tables)
        .find((table) => table.id === holder.id)
        ?.columns.find((item) => item.name === "total");
      expect(column?.error).toBeTruthy();
    });

    it("refuses to take the only possible primary field, and keeps the table as it was", async () => {
      const { id: tableId, physical } = await (async () => {
        made += 1;
        const { id } = await owner.call().catalog.createTable({
          baseId,
          name: `Lonely ${String(made)}`,
          columns: [field("only", "text")],
        });
        const { physicalName } = await db
          .selectFrom("dataTables")
          .select("physicalName")
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        return { id, physical: physicalName };
      })();
      await owner.call().rows.insertMany({ tableId, rows: [{ only: "abc" }] });
      expect(await errorCode(convert(tableId, "only", "boolean"))).toBe(
        "primary_field_needed",
      );
      expect(await stored(physical, "only")).toEqual(["abc"]);
      const primary = await db
        .selectFrom("dataColumns")
        .select("name")
        .where("tableId", "=", tableId)
        .where("isPrimary", "=", true)
        .execute();
      expect(primary.map((item) => item.name)).toEqual(["only"]);
    });

    it("lets a primary field change type when another can name the rows", async () => {
      const { id } = await tableWith(
        [field("other", "text")],
        [{ other: "x" }],
      );
      await convert(id, "title", "boolean");
      const primary = await db
        .selectFrom("dataColumns")
        .select("name")
        .where("tableId", "=", id)
        .where("isPrimary", "=", true)
        .execute();
      expect(primary.map((item) => item.name)).toEqual(["other"]);
    });
  });

  describe("a write that read a field before it changed type", () => {
    const stale = async (tableId: string, physical: string) => {
      const { engine } = await loadEngine(db, tableId, () => true);
      return {
        engine,
        context: {
          userId: ownerId,
          tableId,
          physicalName: physical,
          baseId,
          reason: null,
          source: "web",
        },
      };
    };

    it("is refused, and writes nothing, across a change of storage", async () => {
      const { id, physical, ids } = await tableWith(
        [field("v", "text")],
        [{ v: "12" }],
      );
      const { engine, context } = await stale(id, physical);
      await convert(id, "v", "number");
      expect(
        await errorCode(
          updateRows(db, engine, context, [
            { rowId: ids[0] ?? "", values: { v: "not a number" } },
          ]),
        ),
      ).toBe("field_changed");
      expect(
        await errorCode(
          insertRows(db, engine, context, [{ v: "not a number" }]),
        ),
      ).toBe("field_changed");
      expect(await stored(physical, "v")).toEqual(["12"]);
    });

    it("is refused where both types are stored alike", async () => {
      const { id, physical, ids } = await tableWith(
        [field("v", "text")],
        [{ v: "https://example.org" }],
      );
      const { engine, context } = await stale(id, physical);
      await convert(id, "v", "url");
      expect(
        await errorCode(
          updateRows(db, engine, context, [
            { rowId: ids[0] ?? "", values: { v: "not a link" } },
          ]),
        ),
      ).toBe("field_changed");
      expect(await stored(physical, "v")).toEqual(["https://example.org"]);
    });

    it("goes through when the field it writes did not change", async () => {
      const { id, physical, ids } = await tableWith(
        [field("v", "text"), field("w", "text")],
        [{ v: "12", w: "kept" }],
      );
      const { engine, context } = await stale(id, physical);
      await convert(id, "v", "number");
      await updateRows(db, engine, context, [
        { rowId: ids[0] ?? "", values: { w: "written" } },
      ]);
      expect(await stored(physical, "w")).toEqual(["written"]);
    });
  });

  describe("a row's last modified", () => {
    const stamps = async (physical: string) =>
      (
        await runStatement(db, {
          text: `select "ag_updated_at"::text as "at" from "${physical}" order by "ag_seq"`,
          values: [],
        })
      ).map((row) => row.at as string);

    it("moves only for the rows a conversion changed", async () => {
      const { id, physical } = await tableWith(
        [field("v", "text")],
        [{ v: "12" }, { v: "abc" }, { v: "7.50" }],
      );
      const before = await stamps(physical);
      await convert(id, "v", "number");
      const after = await stamps(physical);
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(after[2]).not.toBe(before[2]);
    });
  });

  describe("two options merged", () => {
    it("leaves one of them in a cell, in its place", async () => {
      const { id, physical } = await tableWith(
        [
          field("m", "multi_select", {
            options: options("Rouge", "Vert", "Bleu"),
          }),
        ],
        [{ m: ["Bleu", "Rouge", "Vert"] }],
      );
      await owner.call().catalog.updateColumn({
        tableId: id,
        name: "m",
        config: { options: options("Vert", "Bleu") },
        optionRenames: [{ from: "Rouge", to: "Vert" }],
      });
      expect(await stored(physical, "m")).toEqual(["{Bleu,Vert}"]);
    });
  });

  describe("a large table", () => {
    const ROWS = 100_000;

    async function seeded(rows: number) {
      const table = await tableWith([field("v", "text")]);
      await withAudit(
        db,
        { userId: ownerId, tableId: table.id, source: "web" },
        (tx) =>
          sql
            .raw(
              `insert into "${table.physical}" ("title", "v") select 'r' || i, (i % 1000)::text from generate_series(1, ${String(rows)}) i`,
            )
            .execute(tx),
      );
      return table;
    }

    const columnType = async (tableId: string, name: string) =>
      (
        await db
          .selectFrom("dataColumns")
          .select("fieldType")
          .where("tableId", "=", tableId)
          .where("name", "=", name)
          .executeTakeFirstOrThrow()
      ).fieldType;

    const leftovers = async (physical: string) => {
      const columns = await runStatement(db, {
        text: `select count(*)::int as "count" from information_schema.columns where table_name = $1 and column_name like 'ag_tmp%'`,
        values: [physical],
      });
      const triggers = await runStatement(db, {
        text: `select count(*)::int as "count" from pg_trigger where tgrelid = to_regclass($1) and tgname = 'ag_converting'`,
        values: [`"${physical}"`],
      });
      return {
        columns: Number(columns[0]?.count),
        guards: Number(triggers[0]?.count),
      };
    };

    it("converts by batches, keeps every write it took, and refuses the rest while read-only", async () => {
      const { id, physical, ids } = await seeded(ROWS);
      const firstIds = (
        await runStatement(db, {
          text: `select "id" from "${physical}" order by "ag_seq" limit 200`,
          values: [],
        })
      ).map((row) => row.id as string);
      expect(ids).toEqual([]);
      const started = await convert(id, "v", "number");
      expect(started.jobId).toBeTruthy();
      const jobId = started.jobId ?? "";

      const accepted = new Map<string, string>();
      const refusals = new Set<string>();
      const refused: string[] = [];
      let reads = 0;
      const writing = { on: true };
      const writer = (async () => {
        let at = 0;
        while (writing.on) {
          const rowId = firstIds[at % firstIds.length] ?? "";
          at += 1;
          const value = String(5000 + at);
          const code = await errorCode(
            owner.call().rows.updateMany({
              tableId: id,
              updates: [{ rowId, values: { v: value } }],
            }),
          );
          if (code === "ok") {
            accepted.set(rowId, value);
          } else {
            refusals.add(code);
            refused.push(value);
          }
          await owner.call().rows.read({ tableId: id, limit: 10 });
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      })();
      await runQueuedJob(queue, jobId, runners, new AbortController().signal);
      writing.on = false;
      await writer;

      const job = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
      expect([job.status, job.errorCode]).toEqual(["done", null]);
      expect(reads).toBeGreaterThan(0);
      // Read-only while the job runs. A write the switch itself catches was
      // checked against the type the field had, and is refused for that.
      expect(
        [...refusals].filter(
          (code) => code !== "table_converting" && code !== "field_changed",
        ),
      ).toEqual([]);
      expect(await columnType(id, "v")).toBe("number");
      expect(await leftovers(physical)).toEqual({ columns: 0, guards: 0 });

      const [count] = await runStatement(db, {
        text: `select count(*)::int as "all", count("v")::int as "kept" from "${physical}"`,
        values: [],
      });
      expect(count).toEqual({ all: ROWS, kept: ROWS });
      for (const [rowId, value] of accepted) {
        const [row] = await runStatement(db, {
          text: `select "v"::text as "value" from "${physical}" where "id" = $1`,
          values: [rowId],
        });
        expect(row?.value).toBe(value);
      }
      // No value a refusal answered was written all the same.
      const [leaked] = await runStatement(db, {
        text: `select count(*)::int as "count" from "${physical}" where "v"::text in (select jsonb_array_elements_text($1::text::jsonb))`,
        values: [JSON.stringify(refused)],
      });
      expect(leaked?.count).toBe(0);
      // Writable again.
      await owner.call().rows.updateMany({
        tableId: id,
        updates: [{ rowId: firstIds[0] ?? "", values: { v: "42" } }],
      });
    }, 240_000);

    it("leaves the type and the values as they were when it fails half way", async () => {
      const { id, physical } = await seeded(30_000);
      const before = await runStatement(db, {
        text: `select md5(string_agg("v", ',' order by "ag_seq")) as "print" from "${physical}"`,
        values: [],
      });
      const stampsOf = () =>
        runStatement(db, {
          text: `select md5(string_agg("ag_updated_at"::text, ',' order by "ag_seq")) as "print" from "${physical}"`,
          values: [],
        });
      const stamped = await stampsOf();
      const started = await convert(id, "v", "number");
      const claimed = await claimJob(db, started.jobId ?? "");
      let calls = 0;
      await expect(
        runners.convert_column({
          job: claimed as JobRow,
          progress: () => {
            calls += 1;
            return calls >= 2
              ? Promise.reject(new Error("stopped half way"))
              : Promise.resolve();
          },
        }),
      ).rejects.toThrow("stopped half way");
      expect(await columnType(id, "v")).toBe("text");
      expect(await leftovers(physical)).toEqual({ columns: 0, guards: 0 });
      const after = await runStatement(db, {
        text: `select md5(string_agg("v", ',' order by "ag_seq")) as "print" from "${physical}"`,
        values: [],
      });
      expect(after).toEqual(before);
      // Nothing happened to these rows: none says it was changed.
      expect(await stampsOf()).toEqual(stamped);
    }, 120_000);

    it("stamps only the rows it changed, once it has finished", async () => {
      const { id, physical } = await seeded(25_000);
      await withAudit(
        db,
        { userId: ownerId, tableId: id, source: "web" },
        (tx) =>
          sql
            .raw(
              `update "${physical}" set "v" = 'not a number' where "ag_seq" in (select "ag_seq" from "${physical}" order by "ag_seq" limit 3)`,
            )
            .execute(tx),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stampOf = async () =>
        new Map(
          (
            await runStatement(db, {
              text: `select "id", "ag_updated_at"::text as "at" from "${physical}"`,
              values: [],
            })
          ).map((row) => [row.id as string, row.at as string]),
        );
      const before = await stampOf();
      const started = await convert(id, "v", "number");
      await runQueuedJob(
        queue,
        started.jobId ?? "",
        runners,
        new AbortController().signal,
      );
      const after = await stampOf();
      const moved = [...after].filter(([row, at]) => before.get(row) !== at);
      expect(moved).toHaveLength(3);
      expect(await leftovers(physical)).toEqual({ columns: 0, guards: 0 });
    }, 120_000);

    it("gives a table back when the worker running its conversion died", async () => {
      const { id, physical, ids } = await tableWith(
        [field("v", "text")],
        [{ v: "12" }],
      );
      const [job] = await db
        .insertInto("jobs")
        .values({
          kind: "convert_column",
          userId: ownerId,
          baseId,
          tableId: id,
          status: "running",
          leaseUntil: new Date(Date.now() - 1000),
          input: { tableId: id, name: "v", fieldType: "number" },
        })
        .returning("id")
        .execute();
      await runStatement(
        db,
        buildConversionTempColumn({
          table: physical,
          column: "v",
          to: "number",
        }),
      );
      await runStatement(db, buildConversionMarks(physical));
      await runStatement(db, buildConversionGuard(physical, job?.id ?? ""));
      expect(await leftovers(physical)).toEqual({ columns: 2, guards: 1 });
      expect(
        await errorCode(
          owner.call().rows.updateMany({
            tableId: id,
            updates: [{ rowId: ids[0] ?? "", values: { v: "13" } }],
          }),
        ),
      ).toBe("table_converting");

      await recoverJobs(queue);

      expect(await leftovers(physical)).toEqual({ columns: 0, guards: 0 });
      await owner.call().rows.updateMany({
        tableId: id,
        updates: [{ rowId: ids[0] ?? "", values: { v: "13" } }],
      });
      expect(await stored(physical, "v")).toEqual(["13"]);
    });
  });
});
