import { describe, expect, it } from "vitest";
import type { EngineCatalog } from "./engine";
import { catalogFor, orders } from "./fixtures.test-helpers";
import { buildReadRows } from "./read";

/** The orders table with a field of its rows' state, and its circuit's order. */
function withState(states?: readonly string[]): EngineCatalog {
  const base = catalogFor();
  return {
    ...base,
    table: {
      ...orders,
      ...(states ? { states } : {}),
      columns: [
        ...orders.columns,
        {
          id: "o-state",
          name: "state",
          label: "State",
          fieldType: "row_state",
          config: {},
        },
      ],
    },
  };
}

describe("a field of the row's state (ADR 0133)", () => {
  it("reads the state the database keeps, and sorts in its circuit's order", () => {
    const page = buildReadRows(withState(["draft", "in_review", "approved"]), {
      limit: 10,
      fields: ["state"],
      sort: [{ column: "state", direction: "asc" }],
    });
    expect(page.text).toContain(`r."ag_status" as "state"`);
    expect(page.text).toMatch(/order by array_position\(.*q\."state"\) asc/);
    expect(page.values).toContain(
      JSON.stringify(["draft", "in_review", "approved"]),
    );
  });

  it("filters by a state's key, and sorts by its key when the order is not known", () => {
    const page = buildReadRows(withState(), {
      limit: 10,
      fields: ["state"],
      filter: {
        conjunction: "and",
        conditions: [{ column: "state", op: "is", value: "approved" }],
      },
      sort: [{ column: "state", direction: "asc" }],
    });
    expect(page.text).toMatch(/lower\(q\."state"\) = lower\(\$\d+::text\)/);
    expect(page.values).toContain("approved");
    expect(page.text).not.toContain("array_position");
  });
});
