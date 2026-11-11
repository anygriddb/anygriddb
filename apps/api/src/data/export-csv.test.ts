import type { EngineCatalog } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { EXPORT_CSV_MAX_LENGTH, exportCsv } from "./export-csv.js";
import type { RowRecord } from "./rows.js";

const engine = {
  table: {
    columns: [
      { name: "title", label: "Title" },
      { name: "price", label: "Price" },
      { name: "secret", label: "Secret" },
    ],
  },
} as unknown as EngineCatalog;

/** Serves `rows` page by page and records the pages asked for. */
function pages(rows: readonly RowRecord[]) {
  const asked: number[] = [];
  return {
    asked,
    read: (offset: number, limit: number) => {
      asked.push(offset);
      return Promise.resolve(rows.slice(offset, offset + limit));
    },
  };
}

const row = (index: number): RowRecord => ({
  id: String(index),
  title: `t${String(index)}`,
  price: index,
  secret: "x",
});

describe("exportCsv", () => {
  it("writes the header once over several pages, with the fields asked for", async () => {
    const source = pages([0, 1, 2, 3, 4].map(row));
    expect(await exportCsv(engine, ["title", "price"], source.read, 2)).toBe(
      "Title,Price\nt0,0\nt1,1\nt2,2\nt3,3\nt4,4",
    );
    expect(source.asked).toEqual([0, 2, 4]);
  });

  it("adds no line when the last page is exactly full", async () => {
    const source = pages([0, 1, 2, 3].map(row));
    expect(await exportCsv(engine, ["title"], source.read, 2)).toBe(
      "Title\nt0\nt1\nt2\nt3",
    );
    expect(source.asked).toEqual([0, 2, 4]);
  });

  it("writes the header alone for an empty table", async () => {
    expect(await exportCsv(engine, undefined, pages([]).read)).toBe(
      "Title,Price,Secret",
    );
  });

  it("refuses a file longer than one answer carries", async () => {
    const long = "x".repeat(EXPORT_CSV_MAX_LENGTH);
    await expect(
      exportCsv(engine, ["title"], pages([{ id: "1", title: long }]).read),
    ).rejects.toMatchObject({ code: "file_too_large" });
  });
});
