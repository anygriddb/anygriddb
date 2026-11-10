import type { MessageDescriptor } from "@lingui/core";
import { describe, expect, it } from "vitest";
import { newTableColumns } from "./new-table-dialog";

// The English source text of each message, as the source locale shows it.
const say = (descriptor: MessageDescriptor) =>
  descriptor.message ?? descriptor.id;

describe("newTableColumns", () => {
  it("names every field and option of the starter table", () => {
    const columns = newTableColumns(say, "starter");
    expect(columns.map((column) => [column.label, column.fieldType])).toEqual([
      ["Name", "text"],
      ["Notes", "long_text"],
      ["Status", "single_select"],
    ]);
    expect(columns[2]?.config?.options.map((option) => option.name)).toEqual([
      "To do",
      "In progress",
      "Done",
    ]);
  });

  it("returns only a named Name field for a blank table, never an empty one", () => {
    const columns = newTableColumns(say, "blank");
    expect(columns).toEqual([{ label: "Name", fieldType: "text" }]);
    expect(columns.every((column) => column.label.trim() !== "")).toBe(true);
  });
});
