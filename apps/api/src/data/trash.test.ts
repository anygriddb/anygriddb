import { describe, expect, it } from "vitest";
import { orderForPurge } from "./trash.js";

describe("orderForPurge", () => {
  it("purges views and fields before their tables, and bases last", () => {
    const ordered = orderForPurge([
      { kind: "base", id: "b" },
      { kind: "table", id: "t" },
      { kind: "view", id: "v" },
      { kind: "column", id: "c" },
    ]);
    expect(ordered.map((item) => item.kind)).toEqual([
      "view",
      "column",
      "table",
      "base",
    ]);
  });
});
