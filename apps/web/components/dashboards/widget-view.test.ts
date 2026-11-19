import { describe, expect, it } from "vitest";
import { embeddedViewId, rowsLeftOut } from "./widget-view";

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
