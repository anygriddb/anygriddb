import { describe, expect, it } from "vitest";
import { resolveRowTint } from "./row-tint";
import type { CatalogColumn, RowItem } from "../../lib/types";

const status = {
  name: "status",
  label: "Status",
  fieldType: "single_select",
  kind: "text",
  config: {
    options: [
      { name: "Open", color: "blue" },
      { name: "Done", color: "green" },
    ],
  },
} as CatalogColumn;

const kinds = new Map([["status", "text" as const]]);
const context = { kinds, timeZone: "UTC" };

describe("resolveRowTint", () => {
  it("tints from a select field", () => {
    const row = { id: "r1", status: "Done" } as unknown as RowItem;
    expect(
      resolveRowTint(
        row,
        [status],
        { mode: "select", column: "status" },
        context,
      ),
    ).toBe("green");
  });

  it("tints from the first matching colour rule", () => {
    const row = { id: "r1", status: "Open" } as unknown as RowItem;
    expect(
      resolveRowTint(
        row,
        [status],
        {
          mode: "rules",
          rules: [
            {
              color: "red",
              filter: {
                conjunction: "and",
                conditions: [{ column: "status", op: "is", value: "Open" }],
              },
            },
            {
              color: "green",
              filter: {
                conjunction: "and",
                conditions: [{ column: "status", op: "is", value: "Done" }],
              },
            },
          ],
        },
        context,
      ),
    ).toBe("red");
  });

  it("returns nothing when no rule matches", () => {
    const row = { id: "r1", status: "Done" } as unknown as RowItem;
    expect(
      resolveRowTint(
        row,
        [status],
        {
          mode: "rules",
          rules: [
            {
              color: "red",
              filter: {
                conjunction: "and",
                conditions: [{ column: "status", op: "is", value: "Open" }],
              },
            },
          ],
        },
        context,
      ),
    ).toBeUndefined();
  });
});
