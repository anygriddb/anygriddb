import { describe, expect, it } from "vitest";
import { goesAlone } from "./trpc";

describe("calls that leave the batch", () => {
  it("sends the reads that may take seconds on their own", () => {
    expect(goesAlone({ type: "query", path: "dashboards.widgetData" })).toBe(
      true,
    );
    expect(goesAlone({ type: "query", path: "rows.aggregate" })).toBe(true);
  });

  it("keeps quick reads and every write in the batch", () => {
    expect(goesAlone({ type: "query", path: "rows.read" })).toBe(false);
    expect(goesAlone({ type: "query", path: "catalog.list" })).toBe(false);
    expect(goesAlone({ type: "mutation", path: "rows.aggregate" })).toBe(false);
  });
});
