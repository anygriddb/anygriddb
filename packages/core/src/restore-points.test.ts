import { describe, expect, it } from "vitest";
import {
  restoreBaseJobInputSchema,
  restorePointJobInputSchema,
} from "./restore-points";

const id = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";

describe("restore point inputs", () => {
  it("takes a base and an optional note, and a point to restore with an optional name", () => {
    expect(
      restorePointJobInputSchema.parse({
        baseId: id,
        note: "  before the import ",
      }).note,
    ).toBe("before the import");
    expect(
      restorePointJobInputSchema.parse({ baseId: id }).note,
    ).toBeUndefined();
    expect(
      restoreBaseJobInputSchema.parse({ restorePointId: id, name: "Ventes" })
        .name,
    ).toBe("Ventes");
  });

  it("refuses a missing base, an empty or long note, and unknown keys", () => {
    expect(restorePointJobInputSchema.safeParse({ note: "x" }).success).toBe(
      false,
    );
    expect(
      restorePointJobInputSchema.safeParse({ baseId: id, note: "  " }).success,
    ).toBe(false);
    expect(
      restorePointJobInputSchema.safeParse({
        baseId: id,
        note: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      restoreBaseJobInputSchema.safeParse({ restorePointId: id, extra: 1 })
        .success,
    ).toBe(false);
  });
});
