import { describe, expect, it } from "vitest";
import { cellLockKey, gridChannel } from "./channels.js";

describe("realtime channels", () => {
  it("names a cell lock and refuses unsafe coordinates", () => {
    expect(cellLockKey("demo", "r1", "name")).toBe("cell:demo:r1:name");
    expect(() => cellLockKey("demo", "r 1", "name")).toThrow(/Invalid row id/);
    expect(gridChannel("abc")).toBe("grid:abc");
    expect(() => gridChannel("a:b")).toThrow(/Invalid grid channel/);
  });
});
