import { describe, expect, it } from "vitest";
import { embeddedViewId } from "./widget-view";

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
