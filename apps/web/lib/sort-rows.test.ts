import { describe, expect, it } from "vitest";
import { sortRows } from "./sort-rows";

const rows = [
  { id: "b", name: "Beryl", n: 2, note: null },
  { id: "a", name: "ada", n: 10, note: "" },
  { id: "c", name: "Ada", n: null, note: "kept" },
];

describe("sorting rows already on the page", () => {
  it("ignores case, and keeps equals in id order", () => {
    expect(
      sortRows(
        rows,
        { key: "name", dir: "asc" },
        (row) => row.name,
        (row) => row.id,
      ).map((row) => row.id),
    ).toEqual(["a", "c", "b"]);
  });

  it("puts empty values last in both directions", () => {
    const byNote = (dir: "asc" | "desc") =>
      sortRows(
        rows,
        { key: "note", dir },
        (row) => row.note,
        (row) => row.id,
      ).map((row) => row.id);
    expect(byNote("asc")).toEqual(["c", "a", "b"]);
    expect(byNote("desc")).toEqual(["c", "a", "b"]);
  });

  it("orders numbers, not their digits", () => {
    expect(
      sortRows(
        rows,
        { key: "n", dir: "asc" },
        (row) => row.n,
        (row) => row.id,
      ).map((row) => row.id),
    ).toEqual(["b", "a", "c"]);
  });
});
