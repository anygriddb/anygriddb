import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../../lib/types";
import { operatorsFor } from "./filter-builder";

function column(
  partial: Partial<CatalogColumn> & Pick<CatalogColumn, "kind" | "name">,
): CatalogColumn {
  return {
    id: "c1",
    label: partial.name,
    description: null,
    fieldType: "text",
    position: 0,
    isPrimary: false,
    isUnique: false,
    requireReason: false,
    access: "write",
    side: false,
    controlPlane: false,
    insertable: true,
    config: {},
    elem: null,
    error: null,
    limits: [],
    ...partial,
  } as CatalogColumn;
}

describe("operatorsFor", () => {
  it("limits control-plane text fields to equality and emptiness", () => {
    expect(
      operatorsFor(column({ name: "note", kind: "text", controlPlane: true })),
    ).toEqual(["is", "is_not", "is_empty", "is_not_empty"]);
  });

  it("limits control-plane booleans to is", () => {
    expect(
      operatorsFor(
        column({
          name: "flag",
          kind: "boolean",
          fieldType: "boolean",
          controlPlane: true,
        }),
      ),
    ).toEqual(["is"]);
  });

  it("keeps the usual text operators for client columns", () => {
    const ops = operatorsFor(column({ name: "title", kind: "text" }));
    expect(ops).toContain("contains");
    expect(ops).toContain("is_empty");
    expect(ops).not.toContain("is_any_of");
  });
});
