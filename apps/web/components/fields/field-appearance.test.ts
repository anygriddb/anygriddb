import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../../lib/types";
import {
  booleanAppearance,
  multiSelectAppearance,
  ratingVisual,
  singleSelectAppearance,
} from "./field-appearance";

function column(
  fieldType: CatalogColumn["fieldType"],
  config: Record<string, unknown> = {},
): CatalogColumn {
  return {
    id: "c",
    name: "f",
    label: "F",
    fieldType,
    config,
  } as CatalogColumn;
}

describe("field appearance helpers", () => {
  it("defaults and accepts configured select / boolean appearances", () => {
    expect(singleSelectAppearance(column("single_select"))).toBe("badge");
    expect(
      singleSelectAppearance(column("single_select", { appearance: "radio" })),
    ).toBe("radio");
    expect(multiSelectAppearance(column("multi_select"))).toBe("badge");
    expect(
      multiSelectAppearance(
        column("multi_select", { appearance: "checklist" }),
      ),
    ).toBe("checklist");
    expect(booleanAppearance(column("boolean"))).toBe("check");
    expect(booleanAppearance(column("boolean", { appearance: "yes_no" }))).toBe(
      "yes_no",
    );
    expect(
      singleSelectAppearance(
        column("single_select", { appearance: "checklist" }),
      ),
    ).toBe("badge");
  });

  it("reads rating visuals with defaults", () => {
    expect(ratingVisual(column("rating"))).toEqual({
      max: 5,
      icon: "star",
      color: null,
    });
    expect(
      ratingVisual(
        column("rating", {
          ratingMax: 7,
          ratingIcon: "heart",
          ratingColor: "pink",
        }),
      ),
    ).toEqual({ max: 7, icon: "heart", color: "pink" });
  });
});
