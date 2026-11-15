import { describe, expect, it } from "vitest";
import { PathAllowList } from "./path-allow-list.js";

describe("source path allow list", () => {
  it("allows files under listed absolute prefixes only", () => {
    const list = new PathAllowList("/var/lib/anygriddb:/tmp/ag-lab");
    expect(list.allows("/var/lib/anygriddb/shop.sqlite")).toBe(true);
    expect(list.allows("/var/lib/anygriddb/nested/x.db")).toBe(true);
    expect(list.allows("/tmp/ag-lab/demo.sqlite")).toBe(true);
    expect(list.allows("/var/lib/other/x.sqlite")).toBe(false);
    expect(list.allows("/etc/passwd")).toBe(false);
  });

  it("allows nothing when empty and refuses relative entries", () => {
    expect(new PathAllowList("").allows("/tmp/x.sqlite")).toBe(false);
    expect(new PathAllowList(undefined).entries).toEqual([]);
    expect(() => new PathAllowList("relative/dir")).toThrow(/absolute/);
    expect(() => new PathAllowList("/good/../bad")).toThrow(/invalid entry/);
  });
});
