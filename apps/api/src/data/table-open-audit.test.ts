import { describe, expect, it } from "vitest";
import { TABLE_OPEN_DEDUP_HOURS } from "./table-open-audit.js";

describe("table open trail", () => {
  it("deduplicates opens inside one hour", () => {
    expect(TABLE_OPEN_DEDUP_HOURS).toBe(1);
  });
});
