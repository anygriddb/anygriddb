import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import type {
  DateMode,
  FilterCondition,
  FilterGroup,
  WithinMode,
} from "../filter";
import { POSTGRES } from "./dialect";
import {
  compileCondition,
  compileFilter,
  type ColumnRef,
  type FilterCheck,
} from "./filter-sql";
import { SqlParams } from "./params";

function compile(op: "is" | "is_within", mode: DateMode | WithinMode) {
  const params = new SqlParams();
  const sql = compileCondition(
    {
      params,
      d: POSTGRES,
      tz: params.bind("Europe/Paris"),
      columns: new Map<string, ColumnRef>([
        ["due", { name: "due", kind: "date" }],
      ]),
    },
    { column: "due", op, value: { mode } },
  );
  return { sql, values: params.values };
}

const today = "(now() at time zone $1)::date";
const startOf = (unit: string) => `date_trunc('${unit}', ${today})::date`;
const between = (from: string, to: string) =>
  `(q."due" >= ${from} and q."due" < ${to})`;
/** A month or a year from `from`, as PostgreSQL adds one. */
const after = (from: string, unit: string) =>
  `(${from} + interval '1 ${unit}')::date`;
const before = (from: string, unit: string) =>
  `(${from} - interval '1 ${unit}')::date`;

describe("a date condition's calendar periods, compiled", () => {
  it.each([
    ["this_week", startOf("week"), `(${startOf("week")} + 7)`],
    [
      "last_week",
      `(${startOf("week")} + -7)`,
      `((${startOf("week")} + -7) + 7)`,
    ],
    ["next_week", `(${startOf("week")} + 7)`, `((${startOf("week")} + 7) + 7)`],
    ["this_month", startOf("month"), after(startOf("month"), "month")],
    [
      "last_month",
      before(startOf("month"), "month"),
      after(before(startOf("month"), "month"), "month"),
    ],
    [
      "next_month",
      after(startOf("month"), "month"),
      after(after(startOf("month"), "month"), "month"),
    ],
    ["this_year", startOf("year"), after(startOf("year"), "year")],
    [
      "last_year",
      before(startOf("year"), "year"),
      after(before(startOf("year"), "year"), "year"),
    ],
    [
      "next_year",
      after(startOf("year"), "year"),
      after(after(startOf("year"), "year"), "year"),
    ],
  ] as const)("%s starts and ends where its unit does", (mode, from, to) => {
    expect(compile("is", mode)).toEqual({
      sql: between(from, to),
      values: ["Europe/Paris"],
    });
  });

  it.each(["this_week", "this_month", "this_year"] as const)(
    "within %s compiles to the same period",
    (mode) => {
      expect(compile("is_within", mode).sql).toBe(compile("is", mode).sql);
    },
  );

  it("within next_month is a month from today, not the month after this one", () => {
    expect(compile("is_within", "next_month").sql).not.toBe(
      compile("is", "next_month").sql,
    );
  });
});

describe("a condition whose value its field cannot use", () => {
  const columns = new Map<string, ColumnRef>([
    ["region", { name: "region", kind: "text" }],
    ["amount", { name: "amount", kind: "number" }],
    ["paid", { name: "paid", kind: "boolean" }],
    ["day", { name: "day", kind: "date" }],
    ["tags", { name: "tags", kind: "options" }],
  ]);
  const context = (check?: FilterCheck) => {
    const params = new SqlParams();
    return {
      params,
      d: POSTGRES,
      tz: params.bind("UTC"),
      columns,
      ...(check ? { check } : {}),
    };
  };
  const group = (...conditions: FilterGroup["conditions"]): FilterGroup => ({
    conjunction: "and",
    conditions,
  });
  const north: FilterCondition = { column: "region", op: "is", value: "north" };
  // The cases a row rule was found to keep every row with.
  const blank: FilterCondition[] = [
    { column: "region", op: "is", value: "" },
    { column: "region", op: "is" },
    { column: "tags", op: "has_any_of", value: [] },
    { column: "amount", op: "is_between", value: ["", ""] },
    { column: "day", op: "is", value: { mode: "exact" } },
  ];
  const unheld: FilterCondition[] = [
    { column: "amount", op: "is", value: "abc" },
    { column: "amount", op: "gt", value: "ten" },
    { column: "paid", op: "is", value: "true" },
    { column: "day", op: "is", value: "not a date" },
    { column: "day", op: "is_within", value: { mode: "today" } },
    { column: "region", op: "contains", value: true },
    { column: "amount", op: "is_between", value: ["1", "ten"] },
  ];
  const refusal = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error instanceof AppError ? [error.code, error.detail] : error;
    }
    return "kept";
  };

  it("is left out of a view's filter, blank or not", () => {
    for (const condition of [...blank, ...unheld]) {
      const sql = compileCondition(context(), condition);
      // A range keeps the end that reads.
      if (condition.op === "is_between" && sql !== null) {
        expect(sql).not.toContain("<=");
      } else {
        expect(sql).toBeNull();
      }
    }
    expect(compileFilter(context(), group(...blank))).toBeNull();
  });

  it("is refused from a request's filter unless it is blank", () => {
    for (const condition of blank) {
      expect(compileCondition(context("values"), condition)).toBeNull();
    }
    for (const condition of unheld) {
      expect(
        refusal(() => compileCondition(context("values"), condition)),
      ).toEqual(["invalid_filter", condition.column]);
    }
    expect(
      compileCondition(context("values"), {
        column: "amount",
        op: "is_between",
        value: ["1", ""],
      }),
    ).toContain(">=");
  });

  it("is refused from a row rule, blank or not, alone or beside a good one", () => {
    for (const condition of [...blank, ...unheld]) {
      expect(
        refusal(() => compileFilter(context("rule"), group(north, condition))),
      ).toEqual(["invalid_filter", condition.column]);
    }
    expect(compileFilter(context("rule"), group(north))).toContain("lower(");
  });

  it("leaves no group of a row rule without a condition", () => {
    expect(refusal(() => compileFilter(context("rule"), group()))).toEqual([
      "invalid_filter",
      undefined,
    ]);
    expect(
      refusal(() =>
        compileFilter(
          context("rule"),
          group(north, { conjunction: "or", conditions: [] }),
        ),
      ),
    ).toEqual(["invalid_filter", undefined]);
    expect(compileFilter(context(), group())).toBeNull();
  });
});
