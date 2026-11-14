import { describe, expect, it } from "vitest";
import { baseActivityInputSchema } from "./activity";

const baseId = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";
const eventId = "6f1f0c34-7a1e-4c55-8d2b-1b9e2f7a3c40";

describe("a base's activity, read a page at a time", () => {
  it("takes a page from the start, or after an event to the microsecond", () => {
    expect(baseActivityInputSchema.parse({ baseId })).toEqual({
      baseId,
      limit: 50,
    });
    const before = `2026-11-14T13:23:47.123456Z_${eventId}`;
    expect(
      baseActivityInputSchema.parse({ baseId, before, limit: 10 }),
    ).toEqual({ baseId, before, limit: 10 });
  });

  it("refuses a cursor that names no event, and a page too long", () => {
    for (const before of [
      "2026-11-14T13:23:47.123Z_" + eventId,
      "2026-11-14T13:23:47.123456Z",
      `2026-11-14T13:23:47.123456Z_${eventId}' or 1=1`,
    ]) {
      expect(
        baseActivityInputSchema.safeParse({ baseId, before }).success,
      ).toBe(false);
    }
    expect(
      baseActivityInputSchema.safeParse({ baseId, limit: 101 }).success,
    ).toBe(false);
  });
});
