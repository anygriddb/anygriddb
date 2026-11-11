import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";
import { failureReporter, type FailureReport } from "./report-failure";

function reporter() {
  const sent: FailureReport[] = [];
  const report = failureReporter(
    (item) => sent.push(item),
    () => "/b/1/t/2",
  );
  return { sent, report };
}

describe("failures a page reports", () => {
  it("says what failed and where, once per failure", () => {
    const { sent, report } = reporter();
    const failure = new TypeError("Cannot read properties of undefined");
    report("render", failure);
    // The window sees the same failure after the page caught it.
    report("error", failure);
    report("error", "a thrown string");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      kind: "render",
      message: "Cannot read properties of undefined",
      path: "/b/1/t/2",
    });
    expect(sent[0]?.stack).toContain("TypeError");
    expect(sent[1]).toEqual({
      kind: "error",
      message: "a thrown string",
      path: "/b/1/t/2",
    });
  });

  it("stops after a few, bounds its words, and leaves refused calls out", () => {
    const { sent, report } = reporter();
    report("rejection", new TRPCClientError("Request rejected"));
    expect(sent).toEqual([]);
    report("error", new Error("x".repeat(2_000)));
    expect(sent[0]?.message).toHaveLength(500);
    for (let index = 0; index < 20; index += 1) {
      report("error", new Error(`failure ${String(index)}`));
    }
    expect(sent).toHaveLength(5);
  });
});
