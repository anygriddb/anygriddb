import { describe, expect, it } from "vitest";
import type { CatalogColumn, ViewConfig } from "../../lib/types";
import { fieldMenuPatch } from "./field-menu";

function column(name: string): CatalogColumn {
  return {
    name,
    label: name,
    fieldType: "text",
    kind: "text",
    controlPlane: false,
    config: {},
  } as unknown as CatalogColumn;
}
const name = column("name");
const notes = column("notes");
const status = column("status");
const visible = [name, notes, status];

describe("fieldMenuPatch", () => {
  it("sorts and groups by the field first, keeping the other levels", () => {
    const config = {
      sort: [{ column: "notes", direction: "asc" }],
      groupBy: [{ column: "status", direction: "desc" }],
    } as ViewConfig;
    expect(fieldMenuPatch("sort-desc", name, { config, visible })).toEqual({
      sort: [
        { column: "name", direction: "desc" },
        { column: "notes", direction: "asc" },
      ],
    });
    // The same field again takes its new direction, once.
    expect(fieldMenuPatch("sort-desc", notes, { config, visible })).toEqual({
      sort: [{ column: "notes", direction: "desc" }],
    });
    expect(fieldMenuPatch("group", notes, { config, visible })).toEqual({
      groupBy: [
        { column: "notes", direction: "asc" },
        { column: "status", direction: "desc" },
      ],
    });
  });

  it("hides the field beside those already hidden", () => {
    const config = { hiddenFields: ["status"] } as ViewConfig;
    expect(fieldMenuPatch("hide", notes, { config, visible })).toEqual({
      hiddenFields: ["status", "notes"],
    });
  });

  it("freezes up to the field, whatever was frozen, and frees every column", () => {
    const config = { frozenColumns: 1 } as ViewConfig;
    expect(fieldMenuPatch("freeze", notes, { config, visible })).toEqual({
      frozenColumns: 2,
    });
    // Up to the field already at the margin: it stays there. The entry
    // that frees the columns is another one, and says so.
    expect(fieldMenuPatch("freeze", name, { config, visible })).toEqual({
      frozenColumns: 1,
    });
    expect(fieldMenuPatch("unfreeze", name, { config, visible })).toEqual({
      frozenColumns: 0,
    });
    expect(
      fieldMenuPatch("unfreeze", notes, {
        config: { frozenColumns: 8 },
        visible,
      }),
    ).toEqual({ frozenColumns: 0 });
  });

  it("freezes no more columns than a view may", () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      column(`field_${String(index)}`),
    );
    const last = many[13];
    expect(last).toBeDefined();
    if (!last) return;
    expect(
      fieldMenuPatch("freeze", last, {
        config: {},
        visible: many,
      }),
    ).toEqual({ frozenColumns: 10 });
  });

  it("adds a condition on the field to the view's filter", () => {
    const config = {
      filter: {
        conjunction: "or",
        conditions: [{ column: "status", op: "is", value: "Done" }],
      },
    } as ViewConfig;
    const patch = fieldMenuPatch("filter", notes, { config, visible });
    expect(patch?.filter?.conjunction).toBe("or");
    expect(patch?.filter?.conditions).toHaveLength(2);
    expect(patch?.filter?.conditions[1]).toMatchObject({ column: "notes" });
  });

  it("changes nothing in the view for an entry that changes the table, or a field not shown", () => {
    const config = {} as ViewConfig;
    expect(
      fieldMenuPatch("delete", notes, { config, visible }),
    ).toBeUndefined();
    expect(
      fieldMenuPatch("primary", notes, { config, visible }),
    ).toBeUndefined();
    expect(
      fieldMenuPatch("freeze", column("hidden"), { config, visible }),
    ).toBeUndefined();
  });
});
