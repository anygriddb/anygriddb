import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { SheetRow } from "./import-file.js";
import { onDisk } from "./import-file.test-helpers.js";
import {
  PARSE_LIMITS,
  readImportFileIsolated,
  scanImportFileIsolated,
} from "./import-isolated.js";
import {
  assertZipFileWithinLimits,
  assertZipWithinLimits,
} from "./zip-limits.js";

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

describe("isolated import reading", () => {
  it(
    "scans, then reads in batches, CSV and XLSX in a worker thread",
    { timeout: 600_000 },
    async () => {
      const lines = Array.from({ length: 5 }, (_, i) => `Firm ${i},Lyon`);
      const csv = await onDisk(
        `Name,City\n${lines.join("\n")}\n`,
        async (path) => {
          const scanned = await scanImportFileIsolated(
            "csv",
            path,
            100,
            FROM_SOURCE,
          );
          const batches: SheetRow[][] = [];
          for await (const batch of readImportFileIsolated(
            scanned.shape,
            path,
            2,
            100,
            FROM_SOURCE,
          )) {
            batches.push(batch);
          }
          return { scanned, batches };
        },
      );
      expect(csv.scanned.preview.headers).toEqual(["Name", "City"]);
      expect(csv.scanned.shape.total).toBe(5);
      expect(csv.batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
      expect(csv.batches[2]).toEqual([{ line: 6, cells: ["Firm 4", "Lyon"] }]);
      const xlsx = await onDisk(
        await workbook([
          ["Name", "Amount"],
          ["Initech", "12"],
        ]),
        (path) => scanImportFileIsolated("xlsx", path, 100, FROM_SOURCE),
      );
      expect(xlsx.preview.headers).toEqual(["Name", "Amount"]);
      expect(xlsx.preview.sample).toEqual([["Initech", "12"]]);
    },
  );

  it("refuses a spreadsheet that declares more than it may inflate", async () => {
    const bomb = declareSize(await workbook([["a"]]), 0x7fffffff);
    expect(() => assertZipWithinLimits(bomb, PARSE_LIMITS.zip)).toThrow(
      "Invalid import",
    );
    await onDisk(bomb, async (path) => {
      await expect(
        assertZipFileWithinLimits(path, PARSE_LIMITS.zip),
      ).rejects.toThrow("Invalid import");
      await expect(scanImportFileIsolated("xlsx", path, 100)).rejects.toThrow(
        "Invalid import",
      );
    });
    expect(() =>
      assertZipWithinLimits(Buffer.from("not a zip"), PARSE_LIMITS.zip),
    ).toThrow("Invalid import");
  });

  it("stops a pass that runs out of time", async () => {
    const big = "a,b\n" + "x,y\n".repeat(400_000);
    await onDisk(big, async (path) => {
      await expect(
        scanImportFileIsolated("csv", path, 1_000_000, {
          heapMb: 512,
          timeMs: 1,
        }),
      ).rejects.toThrow("Invalid import");
    });
  });

  it(
    "keeps the row ceiling's message for the person who uploaded",
    { timeout: 600_000 },
    async () => {
      const records = JSON.stringify(
        Array.from({ length: 1_001 }, () => ({ a: 1 })),
      );
      await onDisk(records, async (path) => {
        await expect(
          scanImportFileIsolated("json", path, 1_000, FROM_SOURCE),
        ).rejects.toThrow("Too many rows to import");
      });
    },
  );
});
