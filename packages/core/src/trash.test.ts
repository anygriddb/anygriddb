import { describe, expect, it } from "vitest";
import {
  TRASH_DAYS,
  purgeCutoff,
  purgeDate,
  restoredName,
  trashPurgeJobInputSchema,
} from "./trash";

const id = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";

describe("trash dates", () => {
  it("purges thirty days after deletion", () => {
    const deleted = new Date("2026-11-01T10:00:00Z");
    expect(purgeDate(deleted).toISOString()).toBe("2026-12-01T10:00:00.000Z");
    const now = new Date("2026-12-01T10:00:01Z");
    expect(purgeCutoff(now).getTime()).toBeGreaterThan(deleted.getTime());
    expect(TRASH_DAYS).toBe(30);
  });

  it("follows the days an administrator chose", () => {
    const deleted = new Date("2026-11-01T10:00:00Z");
    expect(purgeDate(deleted, 7).toISOString()).toBe(
      "2026-11-08T10:00:00.000Z",
    );
    const now = new Date("2026-11-09T10:00:00Z");
    expect(purgeCutoff(now, 7).getTime()).toBeGreaterThan(deleted.getTime());
    expect(purgeCutoff(now).getTime()).toBeLessThan(deleted.getTime());
  });
});

describe("restoredName", () => {
  it("keeps a free name", () => {
    expect(restoredName("Clients", ["Projets"])).toBe("Clients");
  });

  it("numbers a taken name, ignoring case, within the limit", () => {
    expect(restoredName("Clients", ["clients", "Clients (2)"])).toBe(
      "Clients (3)",
    );
    const long = "x".repeat(100);
    const next = restoredName(long, [long], 100);
    expect(next).toHaveLength(100);
    expect(next.endsWith(" (2)")).toBe(true);
  });
});

describe("trash purge job input", () => {
  it("takes a base trash or the due items", () => {
    expect(trashPurgeJobInputSchema.safeParse({ baseId: id }).success).toBe(
      true,
    );
    expect(
      trashPurgeJobInputSchema.safeParse({
        baseId: id,
        items: [{ kind: "table", id }],
      }).success,
    ).toBe(true);
    expect(trashPurgeJobInputSchema.safeParse({ due: true }).success).toBe(
      true,
    );
  });

  it("refuses both, neither, and unknown kinds", () => {
    expect(
      trashPurgeJobInputSchema.safeParse({ baseId: id, due: true }).success,
    ).toBe(false);
    expect(trashPurgeJobInputSchema.safeParse({}).success).toBe(false);
    expect(
      trashPurgeJobInputSchema.safeParse({
        baseId: id,
        items: [{ kind: "row", id }],
      }).success,
    ).toBe(false);
  });
});
