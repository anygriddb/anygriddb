import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { budgetFor, ReadBudget, ReadMemory, rowsBytes } from "./read-budget.js";

const code = (run: () => void): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { code: string }).code;
  }
};

describe("ReadBudget", () => {
  it("lets a request read up to its share", () => {
    const budget = new ReadBudget(new ReadMemory(100), 50);
    expect(code(() => budget.take(50))).toBeNull();
  });

  it("refuses what passes a request's share, and says the page is too large", () => {
    const budget = new ReadBudget(new ReadMemory(100), 50);
    budget.take(40);
    expect(code(() => budget.take(11))).toBe("page_too_large");
  });

  it("refuses when the process holds too much, and gives it back after", () => {
    const memory = new ReadMemory(60);
    const first = new ReadBudget(memory, 50);
    const second = new ReadBudget(memory, 50);
    first.take(50);
    expect(code(() => second.take(11))).toBe("reads_busy");
    first.release();
    expect(code(() => second.take(11))).toBeNull();
  });

  it("stops reading for a response that has gone", () => {
    const response = new EventEmitter();
    const budget = budgetFor(response);
    expect(code(() => budget.take(1))).toBeNull();
    response.emit("close");
    expect(code(() => budget.take(1))).toBe("reads_busy");
  });
});

describe("rowsBytes", () => {
  it("counts what a row's text weighs", () => {
    const small = rowsBytes([{ a: "x" }]);
    const large = rowsBytes([{ a: "x".repeat(1_000) }]);
    expect(large - small).toBe(999);
  });

  it("reaches values nested in arrays and objects", () => {
    expect(rowsBytes([{ a: [{ b: "x".repeat(1_000) }] }])).toBeGreaterThan(
      1_000,
    );
  });

  it("survives a value nested deeper than the call stack", () => {
    let deep: unknown = "x";
    for (let depth = 0; depth < 200_000; depth += 1) deep = [deep];
    expect(rowsBytes([deep])).toBeGreaterThan(200_000);
  });
});
