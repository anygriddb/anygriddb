import { describe, expect, it } from "vitest";
import { kanbanStacks, stackPlaces } from "./kanban-stacks";

describe("stackPlaces", () => {
  it("places each stack where its group starts", () => {
    const places = stackPlaces([
      { keys: ["To do"], depth: 1, count: 1050, start: 0 },
      { keys: ["Done"], depth: 1, count: 3, start: 1050 },
      { keys: [null], depth: 1, count: 50, start: 1053 },
    ]);
    expect(places.get("To do")).toEqual({ start: 0, count: 1050 });
    expect(places.get("Done")).toEqual({ start: 1050, count: 3 });
    expect(places.get("")).toEqual({ start: 1053, count: 50 });
  });

  it("leaves out groups it cannot place", () => {
    const places = stackPlaces([
      { keys: ["To do"], depth: 1, count: 4 },
      { keys: ["To do", "x"], depth: 2, count: 4, start: 0 },
    ]);
    expect(places.size).toBe(0);
    expect(stackPlaces(undefined).size).toBe(0);
  });
});

describe("kanbanStacks", () => {
  it("shows no value, the options in order, then values no longer offered", () => {
    const stacks = kanbanStacks(
      [{ name: "To do", color: "blue" }, { name: "Done" }],
      stackPlaces([
        { keys: ["Archived"], depth: 1, count: 2, start: 0 },
        { keys: ["Done"], depth: 1, count: 1, start: 2 },
      ]),
    );
    expect(stacks).toEqual([
      { id: "", label: "" },
      { id: "To do", label: "To do", color: "blue" },
      { id: "Done", label: "Done" },
      { id: "Archived", label: "Archived" },
    ]);
  });
});
