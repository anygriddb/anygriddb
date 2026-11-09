import { describe, expect, it } from "vitest";
import type { FilterKind } from "./filter";
import { evaluateFilter } from "./filter-eval";
import {
  misplacedConditionFields,
  visibleFormFields,
  type FormFieldRule,
} from "./form-visibility";

const kinds = new Map<string, FilterKind>([
  ["kind", "text"],
  ["amount", "number"],
  ["urgent", "boolean"],
  ["due", "date"],
  ["at", "datetime"],
  ["tags", "options"],
  ["owner", "user"],
  ["reason", "text"],
  ["detail", "text"],
]);
const context = {
  kinds,
  timeZone: "Europe/Paris",
  me: "u1",
  // Monday 9 March 2026, 00:30 in Paris (23:30 UTC the day before).
  now: new Date("2026-03-08T23:30:00Z"),
};
const when = (condition: object) =>
  evaluateFilter(
    { conjunction: "and", conditions: [condition as never] },
    {
      kind: "Panne",
      amount: "1500",
      urgent: true,
      due: "2026-03-10",
      at: "2026-03-08T23:30:00Z",
      tags: ["vip", "eu"],
      owner: ["u1"],
      reason: "",
    },
    context,
  );

describe("evaluateFilter", () => {
  it("reads text without case, numbers, and booleans as the SQL does", () => {
    expect(when({ column: "kind", op: "is", value: "panne" })).toBe(true);
    expect(when({ column: "kind", op: "contains", value: "ANN" })).toBe(true);
    expect(when({ column: "kind", op: "is_any_of", value: ["panne"] })).toBe(
      false,
    );
    expect(when({ column: "detail", op: "is_not", value: "x" })).toBe(true);
    expect(when({ column: "amount", op: "gt", value: "1000" })).toBe(true);
    expect(
      when({ column: "amount", op: "is_between", value: ["", "1500"] }),
    ).toBe(true);
    expect(when({ column: "urgent", op: "is", value: false })).toBe(false);
    expect(when({ column: "reason", op: "is_empty" })).toBe(true);
  });

  it("reads dates in the reader's zone, relative ones from today there", () => {
    expect(when({ column: "at", op: "is", value: { mode: "today" } })).toBe(
      true,
    );
    expect(
      when({ column: "due", op: "is", value: { mode: "this_week" } }),
    ).toBe(true);
    expect(
      when({
        column: "due",
        op: "is_within",
        value: { mode: "next_days", days: 1 },
      }),
    ).toBe(true);
    expect(when({ column: "due", op: "is_before", value: "2026-03-10" })).toBe(
      false,
    );
    expect(
      when({ column: "due", op: "is_on_or_before", value: "2026-03-10" }),
    ).toBe(true);
  });

  it("reads lists and people, `me` included", () => {
    expect(when({ column: "tags", op: "has_all_of", value: ["vip"] })).toBe(
      true,
    );
    expect(when({ column: "tags", op: "is_exactly", value: ["vip"] })).toBe(
      false,
    );
    expect(when({ column: "owner", op: "is", value: ["me"] })).toBe(true);
  });

  it("leaves out blank values, unknown fields, and operators a kind refuses", () => {
    expect(when({ column: "kind", op: "is", value: "" })).toBeNull();
    expect(when({ column: "gone", op: "is", value: "x" })).toBeNull();
    expect(when({ column: "amount", op: "contains", value: "1" })).toBeNull();
  });
});

describe("visibleFormFields", () => {
  const fields: FormFieldRule[] = [
    { column: "kind" },
    {
      column: "reason",
      showIf: {
        conjunction: "and",
        conditions: [{ column: "kind", op: "is", value: "Panne" }],
      },
    },
    {
      column: "detail",
      showIf: {
        conjunction: "and",
        conditions: [{ column: "reason", op: "is_not_empty" }],
      },
    },
    { column: "amount", hidden: true },
    {
      column: "urgent",
      // On a field placed after: left out, so the field shows.
      showIf: {
        conjunction: "and",
        conditions: [{ column: "due", op: "is_empty" }],
      },
    },
    { column: "due" },
  ];

  it("shows a field when earlier answers match, and hides in cascade", () => {
    expect(
      visibleFormFields(fields, { kind: "Panne", reason: "x" }, context),
    ).toEqual(["kind", "reason", "detail", "urgent", "due"]);
    // `reason` is hidden, so it reads as empty for `detail`, whatever it held.
    expect(
      visibleFormFields(fields, { kind: "Question", reason: "x" }, context),
    ).toEqual(["kind", "urgent", "due"]);
  });

  it("names the conditions on fields placed after", () => {
    expect(misplacedConditionFields(fields)).toEqual(
      new Map([["urgent", ["due"]]]),
    );
  });
});
