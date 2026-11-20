import { describe, expect, it } from "vitest";
import type { CatalogColumn, ViewConfig } from "../../lib/types";
import {
  countsByDay,
  kanbanStack,
  prefillForDays,
  prefillFromFilter,
  rowsLayout,
  rowsQuery,
} from "./view-read";

const columns = [
  { name: "name", fieldType: "text", kind: "text", access: "write" },
  { name: "stage", fieldType: "single_select", kind: "text", access: "write" },
  { name: "tags", fieldType: "multi_select", kind: "text", access: "write" },
  { name: "total", fieldType: "formula", kind: "number", access: "write" },
] as unknown as CatalogColumn[];

const scope = {
  conjunction: "and" as const,
  conditions: [{ column: "due", op: "is_not_empty" as const }],
};
const own = {
  conjunction: "and" as const,
  conditions: [{ column: "name", op: "is" as const, value: "Alpha" }],
};

describe("rowsQuery", () => {
  it("leaves a stored view to the server, with what its kind of view adds", () => {
    expect(
      rowsQuery({
        viewId: "v1",
        search: "",
        config: { filter: own },
        local: {},
        scope,
      }),
    ).toEqual({ viewId: "v1", search: undefined, filter: scope });
  });

  it("sends the settings kept locally, and sets the stored filter aside", () => {
    const config = {
      filter: own,
      sort: [{ column: "name", direction: "desc" }],
    } as ViewConfig;
    expect(
      rowsQuery({
        viewId: "v1",
        search: "al",
        config,
        local: { sort: config.sort },
        scope,
      }),
    ).toEqual({
      viewId: "v1",
      search: "al",
      ignoreViewFilter: true,
      sort: config.sort,
      groupBy: undefined,
      filter: { conjunction: "and", conditions: [own, scope] },
    });
  });

  it("sends no filter of the view's while its filters are switched off", () => {
    expect(
      rowsQuery({
        viewId: "v1",
        search: "",
        config: { filter: own, filtersDisabled: true },
        local: { filtersDisabled: true },
        scope: undefined,
      }),
    ).toEqual({
      viewId: "v1",
      search: undefined,
      ignoreViewFilter: true,
      sort: undefined,
      groupBy: undefined,
    });
  });
});

describe("kanbanStack", () => {
  it("is the field the view names, or the first list of options", () => {
    expect(kanbanStack("kanban", { stackColumn: "tags" }, columns)).toBe(
      "tags",
    );
    expect(kanbanStack("kanban", {}, columns)).toBe("stage");
  });

  it("is nothing for another kind of view, or a table with no list", () => {
    expect(kanbanStack("grid", {}, columns)).toBeUndefined();
    expect(kanbanStack("kanban", {}, columns.slice(0, 1))).toBeUndefined();
  });
});

describe("rowsLayout", () => {
  it("reads a grid by pages, and with its groups' starts once grouped", () => {
    expect(
      rowsLayout({ viewType: "grid", grouped: false, stacked: false }),
    ).toBe("pages");
    expect(
      rowsLayout({ viewType: "grid", grouped: true, stacked: false }),
    ).toBe("grouped");
  });

  it("reads a kanban by stacks, a gallery by pages, a calendar in one page", () => {
    expect(
      rowsLayout({ viewType: "kanban", grouped: false, stacked: true }),
    ).toBe("stacks");
    expect(
      rowsLayout({ viewType: "gallery", grouped: false, stacked: false }),
    ).toBe("pages");
    expect(
      rowsLayout({ viewType: "calendar", grouped: false, stacked: false }),
    ).toBe("onePage");
    // A kanban with no field to stack by reads one page, as a list does.
    expect(
      rowsLayout({ viewType: "kanban", grouped: false, stacked: false }),
    ).toBe("onePage");
  });
});

describe("countsByDay", () => {
  it("counts the rows of each day, and leaves inner groups out", () => {
    expect(
      countsByDay([
        { keys: ["2026-03-04"], depth: 1, count: 3 },
        { keys: ["2026-03-04", "x"], depth: 2, count: 2 },
        { keys: [null], depth: 1, count: 1 },
      ]),
    ).toEqual(
      new Map([
        ["2026-03-04", 3],
        ["", 1],
      ]),
    );
  });
});

describe("prefillFromFilter", () => {
  it("gives a new row the values the view asks for", () => {
    expect(
      prefillFromFilter(
        {
          conjunction: "and",
          conditions: [
            { column: "name", op: "is", value: "Alpha" },
            { column: "tags", op: "has_any_of", value: ["a", "b"] },
          ],
        },
        columns,
      ),
    ).toEqual({ name: "Alpha", tags: ["a"] });
  });

  it("gives nothing under an “or”, for a computed field, or for another condition", () => {
    expect(
      prefillFromFilter(
        { conjunction: "or", conditions: own.conditions },
        columns,
      ),
    ).toEqual({});
    expect(
      prefillFromFilter(
        {
          conjunction: "and",
          conditions: [
            { column: "total", op: "is", value: 3 },
            { column: "name", op: "contains", value: "Al" },
            { conjunction: "and", conditions: own.conditions },
          ],
        },
        columns,
      ),
    ).toEqual({});
  });
});

describe("prefillForDays", () => {
  const field = (patch: Record<string, unknown>) =>
    ({
      name: "due",
      fieldType: "date",
      kind: "date",
      access: "write",
      ...patch,
    }) as unknown as CatalogColumn;
  const march = { from: "2026-03-01", to: "2026-03-31" };

  it("gives a new row today when the view shows it, the first day shown otherwise", () => {
    expect(prefillForDays(field({}), march, new Date(2026, 2, 17, 10))).toEqual(
      { due: "2026-03-17" },
    );
    expect(prefillForDays(field({}), march, new Date(2026, 5, 2, 10))).toEqual({
      due: "2026-03-01",
    });
  });

  it("gives a field that keeps a time nine in the morning that day", () => {
    expect(
      prefillForDays(
        field({ fieldType: "datetime", kind: "datetime" }),
        march,
        new Date(2026, 2, 17, 22),
      ),
    ).toEqual({ due: new Date(2026, 2, 17, 9).toISOString() });
  });

  it("gives nothing when the view shows no days, or when its date cannot be written", () => {
    const today = new Date(2026, 2, 17, 10);
    expect(prefillForDays(field({}), undefined, today)).toEqual({});
    expect(prefillForDays(undefined, march, today)).toEqual({});
    // A formula that answers a date, and a date a field rule lets the
    // reader only read.
    expect(
      prefillForDays(field({ fieldType: "formula" }), march, today),
    ).toEqual({});
    expect(prefillForDays(field({ access: "read" }), march, today)).toEqual({});
  });
});
