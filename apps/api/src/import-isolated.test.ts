import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseImportFileIsolated, PARSE_LIMITS } from "./import-isolated.js";
import { assertZipWithinLimits } from "./zip-limits.js";

async function workbook(rows: string[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sheet");
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** Rewrites every declared size in a zip's central directory. */
function declareSize(zip: Buffer, size: number): Buffer {
  const copy = Buffer.from(zip);
  for (let offset = 0; offset + 46 <= copy.length; offset += 1) {
    if (copy.readUInt32LE(offset) === 0x02014b50) {
      copy.writeUInt32LE(size, offset + 24);
    }
  }
  return copy;
}

/**
 * From sources each worker loads tsx and compiles the parser first, which
 * a busy machine (turbo runs lint and typecheck beside) can make slower
 * than a parse's own limit. The bundle's worker is plain JavaScript.
 */
const FROM_SOURCE = { heapMb: 512, timeMs: 240_000 };

describe("isolated import parsing", () => {
  it(
    "parses CSV and XLSX in a worker thread",
    { timeout: 600_000 },
    async () => {
      const csv = await parseImportFileIsolated(
        "csv",
        Buffer.from("Name,City\nAcme,Lyon\n"),
        FROM_SOURCE,
      );
      expect(csv).toEqual({
        headers: ["Name", "City"],
        rows: [["Acme", "Lyon"]],
      });
      const xlsx = await parseImportFileIsolated(
        "xlsx",
        await workbook([
          ["Name", "Amount"],
          ["Initech", "12"],
        ]),
        FROM_SOURCE,
      );
      expect(xlsx.headers).toEqual(["Name", "Amount"]);
      expect(xlsx.rows).toEqual([["Initech", "12"]]);
    },
  );

  it("refuses a spreadsheet that declares more than it may inflate", async () => {
    const bomb = declareSize(await workbook([["a"]]), 0x7fffffff);
    expect(() => assertZipWithinLimits(bomb, PARSE_LIMITS.zip)).toThrow(
      "Invalid import",
    );
    await expect(parseImportFileIsolated("xlsx", bomb)).rejects.toThrow(
      "Invalid import",
    );
    expect(() =>
      assertZipWithinLimits(Buffer.from("not a zip"), PARSE_LIMITS.zip),
    ).toThrow("Invalid import");
  });

  it("stops a parse that runs out of time", async () => {
    const big = Buffer.from(
      "a,b\n" + "x,y\n".repeat(400_000).slice(0, 1_600_000),
    );
    await expect(
      parseImportFileIsolated("csv", big, { heapMb: 512, timeMs: 1 }),
    ).rejects.toThrow("Invalid import");
  });

  it(
    "keeps the row limit message for the person who uploaded",
    { timeout: 600_000 },
    async () => {
      const records = JSON.stringify(
        Array.from({ length: 100_001 }, () => ({ a: 1 })),
      );
      await expect(
        parseImportFileIsolated("json", Buffer.from(records), FROM_SOURCE),
      ).rejects.toThrow("Too many rows");
    },
  );
});
