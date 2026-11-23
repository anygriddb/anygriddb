import { AppError, type EngineCatalog } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { guardingLongJoins, safeTimeZone } from "./rows.js";

describe("safeTimeZone", () => {
  it("keeps a zone the server knows", () => {
    expect(safeTimeZone("Europe/Paris")).toBe("Europe/Paris");
    expect(safeTimeZone("UTC")).toBe("UTC");
  });

  it("reads in UTC without a zone, or with one the server does not know", () => {
    expect(safeTimeZone(undefined)).toBe("UTC");
    // What a browser that cannot tell its zone reports.
    expect(safeTimeZone("Etc/Unknown")).toBe("UTC");
    expect(safeTimeZone("Etc/GMT+25")).toBe("UTC");
    expect(safeTimeZone("UTC'; select 1 --")).toBe("UTC");
  });
});

describe("guardingLongJoins", () => {
  const engine = { tables: new Map() } as unknown as EngineCatalog;
  /** A read that tells how it was asked, and fails as `failures` says. */
  const reading = (failures: readonly AppError[]) => {
    const asked: boolean[] = [];
    const read = (catalog: EngineCatalog) => {
      asked.push(catalog.guardedJoins === true);
      const failure = failures[asked.length - 1];
      return failure === undefined
        ? Promise.resolve(`read ${String(asked.length)}`)
        : Promise.reject(failure);
    };
    return { asked, read };
  };

  it("reads once, joins as they are, when the engine answers", async () => {
    const { asked, read } = reading([]);
    await expect(guardingLongJoins(engine, read)).resolves.toBe("read 1");
    expect(asked).toEqual([false]);
  });

  it("reads again with its joins guarded once the engine refused one", async () => {
    const { asked, read } = reading([new AppError("source_text_too_long")]);
    await expect(guardingLongJoins(engine, read)).resolves.toBe("read 2");
    expect(asked).toEqual([false, true]);
  });

  it("reads a second time at most, and only for a join too long", async () => {
    // Guarded, the engine can still refuse a text of another making.
    const twice = reading([
      new AppError("source_text_too_long"),
      new AppError("source_text_too_long"),
    ]);
    await expect(guardingLongJoins(engine, twice.read)).rejects.toMatchObject({
      code: "source_text_too_long",
    });
    expect(twice.asked).toEqual([false, true]);
    const other = reading([new AppError("source_query_failed")]);
    await expect(guardingLongJoins(engine, other.read)).rejects.toMatchObject({
      code: "source_query_failed",
    });
    expect(other.asked).toEqual([false]);
  });
});
