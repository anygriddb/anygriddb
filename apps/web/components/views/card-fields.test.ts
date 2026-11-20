import { ROW_ERRORS } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { drawnFields } from "./card-fields";

const columns = ["done", "paid", "score", "note", "tags", "total"].map(
  (name) => ({ name }),
);

describe("drawnFields", () => {
  it("keeps the fields that hold something, a box not ticked and a zero among them", () => {
    const row = {
      done: false,
      paid: true,
      score: 0,
      note: "Call back",
      tags: ["Red"],
      total: 12.5,
    };
    expect(drawnFields(row, columns)).toEqual(
      columns.map((column) => ({
        column,
        value: row[column.name as keyof typeof row],
        error: null,
      })),
    );
  });

  it("leaves out a field that holds nothing, name and all", () => {
    expect(
      drawnFields(
        { done: null, paid: undefined, score: null, note: " ", tags: [] },
        columns,
      ),
    ).toEqual([]);
  });

  it("keeps a field whose value is an error, to show it", () => {
    expect(
      drawnFields({ total: null, [ROW_ERRORS]: { total: "DIV0" } }, columns),
    ).toEqual([{ column: { name: "total" }, value: null, error: "DIV0" }]);
  });
});
