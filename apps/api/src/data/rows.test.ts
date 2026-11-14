import { describe, expect, it } from "vitest";
import { safeTimeZone } from "./rows.js";

describe("safeTimeZone", () => {
  it("keeps a zone the server knows", () => {
    expect(safeTimeZone("Europe/Paris")).toBe("Europe/Paris");
    expect(safeTimeZone("UTC")).toBe("UTC");
  });

  it("reads in UTC without a zone, or with one the server does not know", () => {
    expect(safeTimeZone(undefined)).toBe("UTC");
    // What a browser that cannot tell its zone reports.
    expect(safeTimeZone("Etc/Unknown")).toBe("UTC");
    expect(safeTimeZone("Etc/GMT+25")).toBe("UTC");
    expect(safeTimeZone("UTC'; select 1 --")).toBe("UTC");
  });
});
