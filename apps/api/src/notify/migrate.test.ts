import { UpgradeRefused } from "@anygriddb/db";
import { describe, expect, it } from "vitest";
import { migrationFailureLine } from "./migrate.js";

describe("migrationFailureLine", () => {
  it("says a refused upgrade in the words of its check, and nothing else", () => {
    const refused = new UpgradeRefused(
      "0002_fewer",
      new Error("Empty the things first"),
    );
    expect(migrationFailureLine(refused)).toEqual([
      "Upgrade refused by 0002_fewer, before anything was changed: Empty the things first",
    ]);
  });

  it("logs any other failure without its message", () => {
    const failed = new Error("Migration 0002_fewer failed", {
      cause: new Error("duplicate key value (ada@example.org)"),
    });
    const [title, logged] = migrationFailureLine(failed);
    expect(title).toBe("database migration failed");
    expect(logged).toMatchObject({ type: "Error", cause: { type: "Error" } });
    expect(JSON.stringify(logged)).not.toContain("example.org");
    expect(JSON.stringify(logged)).not.toContain("0002_fewer failed");
  });
});
