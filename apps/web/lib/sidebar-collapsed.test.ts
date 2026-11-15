import { describe, expect, it } from "vitest";
import { parseSidebarCollapsed, toggleSidebarFold } from "./sidebar-collapsed";

describe("parseSidebarCollapsed", () => {
  it("starts empty when nothing was stored", () => {
    expect([...parseSidebarCollapsed(null)]).toEqual([]);
  });

  it("reads a list of folded ids", () => {
    expect(
      [...parseSidebarCollapsed(JSON.stringify(["base-1", "folder-2"]))].sort(),
    ).toEqual(["base-1", "folder-2"]);
  });

  it("ignores a corrupted store", () => {
    expect([...parseSidebarCollapsed("{not-json")]).toEqual([]);
    expect([...parseSidebarCollapsed(JSON.stringify({ a: 1 }))]).toEqual([]);
    expect([...parseSidebarCollapsed(JSON.stringify([1, "ok"]))]).toEqual([
      "ok",
    ]);
  });
});

describe("toggleSidebarFold", () => {
  const bases = [
    { id: "b1", folders: [{ id: "f1" }] },
    { id: "b2", folders: [] as { id: string }[] },
  ];

  it("folds every base and leaves a folder as it was", () => {
    expect(
      [...toggleSidebarFold(new Set(["pin", "f1"]), bases)].sort(),
    ).toEqual(["b1", "b2", "f1", "pin"]);
  });

  it("opens the bases again and leaves folders folded", () => {
    const shut = toggleSidebarFold(new Set(["f1"]), bases);
    expect([...toggleSidebarFold(shut, bases)].sort()).toEqual(["f1"]);
  });

  it("changes nothing when there is no base", () => {
    expect([...toggleSidebarFold(new Set(["pin"]), [])]).toEqual(["pin"]);
  });
});
