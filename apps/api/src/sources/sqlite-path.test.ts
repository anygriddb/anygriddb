import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import { PathAllowList } from "./path-allow-list.js";
import { resolveSqliteDatabase } from "./sqlite-path.js";

describe("sqlite database path", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses relative paths, traversal, and paths outside the list", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ag-sqlite-guard-"));
    dirs.push(root);
    const access = {
      paths: new PathAllowList(root),
      allowMemory: false,
    };
    expect(() => resolveSqliteDatabase("shop.sqlite", access)).toThrow(
      AppError,
    );
    expect(() =>
      resolveSqliteDatabase(path.join(root, "..", "other.db"), access),
    ).toThrow(AppError);
    expect(resolveSqliteDatabase(path.join(root, "ok.db"), access)).toBe(
      path.join(root, "ok.db"),
    );
    const outside = path.join(tmpdir(), "ag-sqlite-out");
    expect(() => resolveSqliteDatabase(`${outside}/x.db`, access)).toThrow(
      AppError,
    );
  });

  it("allows :memory: only when gated", () => {
    const access = { paths: new PathAllowList(""), allowMemory: false };
    expect(() => resolveSqliteDatabase(":memory:", access)).toThrow(AppError);
    expect(
      resolveSqliteDatabase(":memory:", { ...access, allowMemory: true }),
    ).toBe(":memory:");
  });
});
