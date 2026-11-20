import { describe, expect, it } from "vitest";
import {
  categoriesAsked,
  embeddedViewId,
  measureAddsUp,
  measuredColumn,
  rowsLeftOut,
} from "./widget-view";

const VIEWS = [{ id: "grid" }, { id: "kanban" }];

describe("embeddedViewId", () => {
  it("takes the view chosen", () => {
    expect(embeddedViewId(VIEWS, "kanban")).toBe("kanban");
  });

  it("takes the first, the one the list shows, while none is chosen", () => {
    expect(embeddedViewId(VIEWS, "")).toBe("grid");
    expect(embeddedViewId([{ id: "only" }], "")).toBe("only");
  });

  it("leaves a view of another table for this table's first", () => {
    expect(embeddedViewId(VIEWS, "of-another-table")).toBe("grid");
  });

  it("has none to give while the table's views are not read", () => {
    expect(embeddedViewId([], "")).toBe("");
  });
});

describe("rowsLeftOut", () => {
  it("counts the rows of the view the widget does not show", () => {
    expect(rowsLeftOut(20, 153)).toBe(133);
  });

  it("leaves none out of a short view, or of one that was not counted", () => {
    expect(rowsLeftOut(3, 3)).toBe(0);
    expect(rowsLeftOut(20, undefined)).toBe(0);
    expect(rowsLeftOut(20, null)).toBe(0);
  });
});

describe("measuredColumn", () => {
  const TABLES = [
    { id: "invoices", columns: [{ name: "amount" }, { name: "paid_on" }] },
    { id: "clients", columns: [{ name: "amount" }] },
  ];

  it("finds the field a widget measures, in the widget's table", () => {
    expect(
      measuredColumn(TABLES, { tableId: "invoices", column: "amount" }),
    ).toBe(TABLES[0]?.columns[0]);
  });

  it("has none for a widget that counts rows, a field that is gone, or a catalog not read yet", () => {
    expect(measuredColumn(TABLES, { tableId: "invoices" })).toBeUndefined();
    expect(
      measuredColumn(TABLES, { tableId: "invoices", column: "vat" }),
    ).toBeUndefined();
    expect(
      measuredColumn(TABLES, { tableId: "gone", column: "amount" }),
    ).toBeUndefined();
    expect(
      measuredColumn(undefined, { tableId: "invoices", column: "amount" }),
    ).toBeUndefined();
  });
});

describe("measureAddsUp", () => {
  it("says a count and a sum add up, a mean and an extreme do not", () => {
    expect(measureAddsUp("sum")).toBe(true);
    expect(measureAddsUp("count_all")).toBe(true);
    expect(measureAddsUp("avg")).toBe(false);
    expect(measureAddsUp("max")).toBe(false);
  });
});

describe("categoriesAsked", () => {
  it("takes a whole number of categories, within what a chart draws", () => {
    expect(categoriesAsked("15", 40)).toBe(15);
    expect(categoriesAsked(" 7.9 ", 40)).toBe(7);
    expect(categoriesAsked("400", 40)).toBe(40);
    expect(categoriesAsked("0", 40)).toBe(1);
  });

  it("asks for none in particular when nothing, or no number, is typed", () => {
    expect(categoriesAsked("", 40)).toBeNull();
    expect(categoriesAsked("   ", 40)).toBeNull();
    expect(categoriesAsked("many", 40)).toBeNull();
  });
});
