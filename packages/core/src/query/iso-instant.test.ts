import { describe, expect, it } from "vitest";
import { parseIsoInstant } from "./iso-instant";

describe("parseIsoInstant", () => {
  it("reads AnyGridDB's ISO 8601 grammar", () => {
    expect(parseIsoInstant(" 2026-01-10 09:30 ")).toEqual({
      timestamp: "2026-01-10 09:30:00",
      utc: false,
    });
    expect(parseIsoInstant("2026-01-10T09:30:00.25")).toEqual({
      timestamp: "2026-01-10 09:30:00.25",
      utc: false,
    });
    expect(parseIsoInstant("2026-01-10T12:00+0530")?.timestamp).toBe(
      "2026-01-10 06:30:00",
    );
    expect(parseIsoInstant("2026-01-10T09:59:00+02:00")?.timestamp).toBe(
      "2026-01-10 07:59:00",
    );
    expect(parseIsoInstant("2026-01-01T00:30-01")?.timestamp).toBe(
      "2026-01-01 01:30:00",
    );
    expect(parseIsoInstant("2026-01-10 Z")).toEqual({
      timestamp: "2026-01-10 00:00:00",
      utc: true,
    });
  });

  it("refuses what is not an instant", () => {
    for (const text of [
      "2026-02-30",
      "2026-13-01",
      "2026-01-10T24:00",
      "2026-01-10T09:30:5",
      "2026-01-10T",
      "2026-01-10 +24",
      "10/01/2026",
      "",
    ]) {
      expect(parseIsoInstant(text), text).toBeNull();
    }
    expect(parseIsoInstant("2024-02-29")).not.toBeNull();
    expect(parseIsoInstant("0999-01-01", 1000)).toBeNull();
  });
});
