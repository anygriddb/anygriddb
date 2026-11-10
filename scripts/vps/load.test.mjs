import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { percentile, summarizeLatencies } from "./load.mjs";

describe("percentile", () => {
  it("returns null for an empty series", () => {
    assert.equal(percentile([], 50), null);
  });

  it("returns the only sample", () => {
    assert.equal(percentile([12], 95), 12);
  });

  it("interpolates between ranks", () => {
    const samples = [10, 20, 30, 40];
    assert.equal(percentile(samples, 50), 25);
  });
});

describe("summarizeLatencies", () => {
  it("fills p50/p95 for a known series", () => {
    const summary = summarizeLatencies([10, 20, 30, 40, 50]);
    assert.equal(summary.count, 5);
    assert.equal(summary.min, 10);
    assert.equal(summary.max, 50);
    assert.equal(summary.p50, 30);
    assert.ok(summary.p95 >= 40);
  });
});
