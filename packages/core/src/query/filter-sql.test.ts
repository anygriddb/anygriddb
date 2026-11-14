import { describe, expect, it } from "vitest";
import type { DateMode, WithinMode } from "../filter";
import { POSTGRES } from "./dialect";
import { compileCondition, type ColumnRef } from "./filter-sql";
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
