import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../../lib/types";
import {
  canDateBy,
  canDuplicate,
  canGroupBy,
  canSortBy,
  canStackBy,
  endField,
  startField,
  stackField,
} from "./field-roles";

function field(
  name: string,
  fieldType: string,
  kind: string,
  controlPlane = false,
): CatalogColumn {
  return { name, fieldType, kind, controlPlane } as unknown as CatalogColumn;
}

const name = field("name", "text", "text");
const files = field("files", "attachment", "files");
const stage = field("stage", "single_select", "text");
const tags = field("tags", "multi_select", "text");
const day = field("day", "date", "date");
const moment = field("moment", "datetime", "datetime");
// Kept in AnyGridDB beside a client's rows.
const keptNote = field("kept_note", "text", "text", true);
const keptStage = field("kept_stage", "single_select", "text", true);
const keptDay = field("kept_day", "date", "date", true);

describe("what a field can do for a view", () => {
  it("groups by nothing the table's engine cannot compare", () => {
    const links = {
      ...field("albums", "relation_one_to_many", "links"),
      noGroup: true,
    } as CatalogColumn;
    expect(canSortBy(links)).toBe(true);
    expect(canGroupBy(links)).toBe(false);
  });

  it("duplicates a formula on any table, a stored field where it is kept", () => {
    const formula = field("total", "formula", "number");
    expect(canDuplicate(formula, false)).toBe(true);
    expect(canDuplicate(name, true)).toBe(true);
    expect(canDuplicate(name, false)).toBe(false);
    expect(canDuplicate(field("made", "created_at", "datetime"), true)).toBe(
      false,
    );
  });

  it("sorts and groups rows, files apart, which make no group", () => {
    expect(canSortBy(name)).toBe(true);
    expect(canGroupBy(name)).toBe(true);
    expect(canSortBy(files)).toBe(true);
    expect(canGroupBy(files)).toBe(false);
  });

  it("neither sorts nor groups a client's rows when AnyGridDB keeps it", () => {
    expect(canSortBy(keptNote)).toBe(false);
    expect(canGroupBy(keptNote)).toBe(false);
  });

  it("stacks a kanban when it is a list of one option the rows can be grouped by", () => {
    expect(canStackBy(stage)).toBe(true);
    expect(canStackBy(tags)).toBe(false);
    expect(canStackBy(name)).toBe(false);
    expect(canStackBy(keptStage)).toBe(false);
  });

  it("places rows on days when it is a day or a moment the client's database holds", () => {
    expect(canDateBy(day)).toBe(true);
    expect(canDateBy(moment)).toBe(true);
    expect(canDateBy(name)).toBe(false);
    expect(canDateBy(keptDay)).toBe(false);
  });
});

describe("stackField", () => {
  it("is the field the view names, or the first list that can stack", () => {
    const columns = [name, tags, stage];
    expect(stackField({ stackColumn: "tags" }, columns)).toBe(tags);
    expect(stackField({}, columns)).toBe(stage);
  });

  it("leaves a field that cannot group rows for the first that can stack them", () => {
    expect(stackField({ stackColumn: "kept_stage" }, [keptStage, stage])).toBe(
      stage,
    );
    // A field the table no longer has.
    expect(stackField({ stackColumn: "gone" }, [name, stage])).toBe(stage);
  });

  it("is nothing when no field can stack", () => {
    expect(stackField({}, [name, keptStage])).toBeUndefined();
    expect(
      stackField({ stackColumn: "kept_stage" }, [name, keptStage]),
    ).toBeUndefined();
  });
});

describe("startField and endField", () => {
  it("are the fields the view names, the start else the first day", () => {
    const columns = [name, day, moment];
    expect(startField({ startColumn: "moment" }, columns)).toBe(moment);
    expect(startField({}, columns)).toBe(day);
    expect(endField({ endColumn: "moment" }, columns)).toBe(moment);
    expect(endField({}, columns)).toBeUndefined();
  });

  it("leave a field that cannot place rows: the start for the first that can, the end for none", () => {
    const columns = [keptDay, day];
    expect(startField({ startColumn: "kept_day" }, columns)).toBe(day);
    expect(endField({ endColumn: "kept_day" }, columns)).toBeUndefined();
    expect(startField({ startColumn: "name" }, [name, day])).toBe(day);
  });

  it("are nothing when no field can place rows", () => {
    expect(startField({}, [name, keptDay])).toBeUndefined();
    expect(
      startField({ startColumn: "kept_day" }, [name, keptDay]),
    ).toBeUndefined();
  });
});
