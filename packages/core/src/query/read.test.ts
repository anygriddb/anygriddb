import { describe, expect, it } from "vitest";
import {
  buildAggregates,
  buildCountRows,
  buildGroupCounts,
  buildReadRows,
  describeColumns,
} from "./read";
import {
  catalogFor,
  clients,
  CLIENTS_ID,
  orders,
} from "./fixtures.test-helpers";
import { parseFormula } from "../formula";

describe("buildReadRows", () => {
  it("compiles formulas, links, lookups, and paging into one bound query", () => {
    const sql = buildReadRows(catalogFor(), {
      limit: 50,
      offset: 100,
      sort: [{ column: "total", direction: "desc" }],
      filter: {
        conjunction: "or",
        conditions: [
          { column: "status", op: "is", value: "Open" },
          { column: "total", op: "gt", value: 10 },
        ],
      },
      timeZone: "Europe/Paris",
    });
    expect(sql.text).toContain(`from "t_orders" r`);
    expect(sql.text).toContain(`(r."price" * r."qty") as "total"`);
    expect(sql.text).toContain(`jsonb_build_object('id', t`);
    expect(sql.text).toContain(`as "client_city"`);
    expect(sql.text).toMatch(
      /where \(\(lower\(q\."status"\) = lower\(\$\d+::text\)\) or \(q\."total" > \$\d+::numeric\)\)/,
    );
    expect(sql.text).toMatch(
      /order by q\."total" desc nulls last, q\."ag_seq" asc limit \$\d+ offset \$\d+$/,
    );
    expect(sql.values).not.toContain("Europe/Paris");
    expect(sql.values).toContain("Open");
    expect(sql.values.slice(-2)).toEqual([50, 100]);
    expect(sql.text).not.toMatch(/'Open'/);
  });

  it("hides an unreadable link target and degrades a broken formula", () => {
    const sql = buildReadRows(catalogFor(false), { limit: 10 });
    expect(sql.text).not.toContain("t_secret");
    expect(sql.text).toContain(`'[]'::jsonb as "codes"`);
    expect(sql.text).toContain(`null::text as "broken"`);
    const broken = sql.columns.find((column) => column.name === "broken");
    expect(broken?.error).toMatch(/Unknown column/);
    const readable = buildReadRows(catalogFor(true), { limit: 10 });
    expect(readable.text).toContain(`"j_codes"`);
  });

  it("rejects bad bounds, unknown columns, and operators that do not fit", () => {
    expect(() => buildReadRows(catalogFor(), { limit: 1001 })).toThrow(
      "Invalid limit",
    );
    expect(() => buildReadRows(catalogFor(), { limit: 1, offset: -1 })).toThrow(
      "Invalid offset",
    );
    expect(() =>
      buildReadRows(catalogFor(), {
        limit: 1,
        sort: [{ column: "nope", direction: "asc" }],
      }),
    ).toThrow("Unknown column: nope");
    expect(() =>
      buildReadRows(catalogFor(), {
        limit: 1,
        filter: {
          conjunction: "and",
          conditions: [{ column: "price", op: "contains", value: "1" }],
        },
      }),
    ).toThrow("Invalid filter");
  });
});

describe("formula errors (ADR 0036)", () => {
  const refs = [
    { name: "price", label: "Price" },
    { name: "checked", label: "Checked" },
  ];
  const formula = (name: string, source: string) => ({
    id: name,
    name,
    label: name === "checked" ? "Checked" : name,
    fieldType: "formula" as const,
    config: { expr: parseFormula(source, refs) },
  });
  const read = (...columns: ReturnType<typeof formula>[]) =>
    buildReadRows(
      {
        ...catalogFor(),
        table: { ...orders, columns: [...orders.columns, ...columns] },
      },
      { limit: 5 },
    );

  it("carries an error beside the value, through the fields that read it", () => {
    const sql = read(
      formula("checked", 'IF({Price} < 0, ERROR("négatif"), {Price})'),
      formula("doubled", "{Checked} * 2"),
      formula("caught", "IF(IS_ERROR({Checked}), 0, {Checked})"),
    );
    const errors = new Map(
      sql.columns.map((column) => [column.name, column.errorSql]),
    );
    // The message is bound, and reaches the fields that read the value.
    expect(sql.values).toContain("négatif");
    expect(errors.get("checked")).toMatch(/then coalesce\(\$\d+::text, ''\)/);
    expect(errors.get("doubled")).toMatch(/then coalesce\(\$\d+::text, ''\)/);
    expect(errors.get("caught")).toBeDefined();
    expect(sql.text).toMatch(/as "ag_errors"/);
    expect(sql.text).toContain("jsonb_strip_nulls(jsonb_build_object(");
  });

  it("costs nothing where no error can arise", () => {
    const sql = read(
      formula("checked", "IS_ERROR(ERROR())"),
      formula("plain", "{Price} + 1"),
    );
    expect(sql.columns.every((column) => column.errorSql === undefined)).toBe(
      true,
    );
    expect(sql.text).not.toContain("ag_errors");
  });
});

describe("formulas a field cannot compute", () => {
  it("names the function whose arguments it refuses", () => {
    const refs = [{ name: "due", label: "Due" }];
    const sources = [
      'DATETIME_PARSE("01/02/2026", "DD/MM")',
      'DATETIME_PARSE("01/02/2026", "DD/MM/YYYY/DD")',
      'DATETIME_PARSE("2026-01-01 10", "YYYY-MM-DD HH")',
      'WORKDAY({Due}, 1, "2026-01-01, 01/05/2026")',
    ];
    const catalog = catalogFor();
    const table = {
      ...orders,
      columns: [
        ...orders.columns,
        ...sources.map((source, index) => ({
          id: `x${String(index)}`,
          name: `x${String(index)}`,
          label: `x${String(index)}`,
          fieldType: "formula" as const,
          config: { expr: parseFormula(source, refs) },
        })),
      ],
    };
    const sql = buildReadRows({ ...catalog, table }, { limit: 1 });
    for (const index of sources.keys()) {
      const column = sql.columns.find(
        (item) => item.name === `x${String(index)}`,
      );
      expect(column?.error, sources[index]).toMatch(/Invalid arguments/);
    }
  });

  it("reads JSON on PostgreSQL 16 and later only", () => {
    const json = {
      id: "j",
      name: "j",
      label: "j",
      fieldType: "formula" as const,
      config: { expr: parseFormula('JSON_EXTRACT("{}", "$.a")', []) },
    };
    const at = (serverVersion: number[]) =>
      buildReadRows(
        {
          ...catalogFor(),
          table: {
            ...orders,
            columns: [...orders.columns, json],
            serverVersion,
          },
        },
        { limit: 1 },
      ).columns.find((item) => item.name === "j");
    expect(at([15, 8])?.error).toMatch(/cannot compute/);
    expect(at([16, 0])?.error).toBeUndefined();
  });
});

describe("filters", () => {
  it("handles relative dates, sets, emptiness, and blank values", () => {
    const sql = buildReadRows(catalogFor(), {
      limit: 5,
      me: "11111111-1111-4111-8111-111111111111",
      filter: {
        conjunction: "and",
        conditions: [
          {
            column: "due",
            op: "is_within",
            value: { mode: "past_days", days: 7 },
          },
          { column: "tags", op: "has_any_of", value: ["vip"] },
          { column: "client", op: "contains", value: "acme" },
          { column: "title", op: "is_not_empty" },
          { column: "title", op: "contains", value: "" },
          {
            conjunction: "or",
            conditions: [
              { column: "client_city", op: "contains", value: "Paris" },
            ],
          },
        ],
      },
    });
    expect(sql.text).toMatch(/\(now\(\) at time zone \$\d+::text\)::date/);
    expect(sql.text).toContain(
      `coalesce(q."tags" && array(select jsonb_array_elements_text(`,
    );
    expect(sql.text).toContain(`e->>'label' ilike`);
    expect(sql.text).toContain(`(not (coalesce(q."title", '') = ''))`);
    expect(sql.values).toContain("%acme%");
    expect(sql.values).toContain(7);
    expect(sql.values).toContain('["vip"]');
  });

  it("keeps both ends of a range, leaves a blank end open, and refuses odd values", () => {
    const where = (conditions: unknown[]) =>
      buildReadRows(catalogFor(), {
        limit: 5,
        filter: { conjunction: "and", conditions: conditions as never },
      });
    const sql = where([
      { column: "total", op: "is_between", value: ["1.10", "2e3"] },
      { column: "due", op: "is_between", value: ["", "2026-03-31"] },
      { column: "price", op: "is_between", value: ["", ""] },
      { column: "qty", op: "is_between", value: ["x", "7"] },
    ]);
    expect(sql.text).toMatch(
      /\(q\."total" >= \$\d+::numeric and q\."total" <= \$\d+::numeric\)/,
    );
    expect(sql.text).toMatch(/\(q\."due" <= \$\d+::date\)/);
    expect(sql.text).not.toMatch(/q\."price" [<>]/);
    expect(sql.text).toMatch(/\(q\."qty" <= \$\d+::numeric\)/);
    expect(sql.values).toEqual(
      expect.arrayContaining(["1.1", "2000", "2026-03-31", "7"]),
    );
    expect(() =>
      where([{ column: "total", op: "is_between", value: ["1", "2", "3"] }]),
    ).toThrow("Invalid filter");
    expect(() =>
      where([{ column: "title", op: "is_between", value: ["a", "b"] }]),
    ).toThrow("Invalid filter");
  });
});

describe("count, groups, aggregates", () => {
  it("counts, groups with grouping sets, and aggregates", () => {
    expect(buildCountRows(catalogFor(), { search: "x" }).text).toMatch(
      /^select count\(\*\)::int as "total" from \(select/,
    );
    const groups = buildGroupCounts(catalogFor(), {
      groupBy: [
        { column: "status", direction: "asc" },
        { column: "due", direction: "desc" },
      ],
    });
    expect(groups?.text).toContain(
      `group by grouping sets (("k0"), ("k0", "k1"))`,
    );
    expect(buildGroupCounts(catalogFor(), {})).toBeNull();
    const aggregates = buildAggregates(catalogFor(), {}, [
      { column: "total", fn: "sum" },
      { column: "title", fn: "count_empty" },
    ]);
    // The sum of an exact number is exact: decimal text (ADR 0023),
    // computed in a derived table and only then made JSON.
    expect(aggregates.text).toContain(`(sum(q."total"))::text as "a0"`);
    expect(aggregates.text).toMatch(
      /^select to_jsonb\(a\."a0"\) as "a0", to_jsonb\(a\."a1"\) as "a1" from \(select /,
    );
    expect(() =>
      buildAggregates(catalogFor(), {}, [{ column: "title", fn: "sum" }]),
    ).toThrow("Invalid aggregate");
  });

  it("describes column kinds, including formula results", () => {
    const kinds = Object.fromEntries(
      describeColumns(catalogFor()).map((column) => [column.name, column.kind]),
    );
    expect(kinds.total).toBe("number");
    expect(kinds.client).toBe("links");
    expect(kinds.client_city).toBe("array");
    expect(kinds.code_count).toBe("number");
    expect(kinds.created).toBe("datetime");
  });

  it("shows a duration's lookups and unit-keeping rollups as durations", () => {
    const base = catalogFor();
    const clientsWithWait = {
      ...clients,
      columns: [
        ...clients.columns,
        {
          id: "c3",
          name: "wait",
          label: "Wait",
          fieldType: "duration" as const,
          config: { durationFormat: "h:mm:ss" as const },
        },
      ],
    };
    const rollup = (name: string, fn: "sum" | "variance" | "std_dev_pop") => ({
      id: name,
      name,
      label: name,
      fieldType: "rollup" as const,
      config: { relation: "client", target: "wait", fn },
    });
    const catalog = {
      ...base,
      table: {
        ...base.table,
        columns: [
          ...base.table.columns,
          rollup("wait_sum", "sum"),
          rollup("wait_var", "variance"),
          rollup("wait_spread", "std_dev_pop"),
          {
            id: "wait_list",
            name: "wait_list",
            label: "wait_list",
            fieldType: "lookup" as const,
            config: { relation: "client", target: "wait" },
          },
        ],
      },
      tables: new Map([...base.tables, [CLIENTS_ID, clientsWithWait]]),
    };
    const durations = Object.fromEntries(
      describeColumns(catalog).map((column) => [column.name, column.duration]),
    );
    expect(durations.wait_sum).toBe("h:mm:ss");
    expect(durations.wait_spread).toBe("h:mm:ss");
    expect(durations.wait_list).toBe("h:mm:ss");
    // Squared seconds are not a duration.
    expect(durations.wait_var).toBeUndefined();
    expect(durations.client_city).toBeUndefined();
  });
});
