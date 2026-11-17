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

  it("freezes up to the field, and frees the columns from the last frozen one", () => {
    const config = { frozenColumns: 1 } as ViewConfig;
    expect(fieldMenuPatch("freeze", notes, { config, visible })).toEqual({
      frozenColumns: 2,
    });
    expect(fieldMenuPatch("freeze", name, { config, visible })).toEqual({
      frozenColumns: 0,
    });
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
