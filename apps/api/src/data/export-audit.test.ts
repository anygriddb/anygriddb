import { describe, expect, it } from "vitest";
import { exportRecordOf } from "./export-audit.js";

describe("an export kept on the trail", () => {
  it("is read back from the event that keeps it", () => {
    expect(
      exportRecordOf({ kind: "view", format: "csv", rows: 12, viewId: "v" }),
    ).toEqual({ kind: "view", format: "csv", rows: 12, viewId: "v" });
    expect(exportRecordOf({ kind: "access_report", format: "csv" })).toEqual({
      kind: "access_report",
      format: "csv",
    });
  });

  it("is not read from an event that changed a row", () => {
    expect(exportRecordOf({ name: "Ada", kind: "note" })).toBeNull();
    expect(exportRecordOf({ kind: "view" })).toBeNull();
    expect(exportRecordOf(null)).toBeNull();
    expect(exportRecordOf("view")).toBeNull();
  });
});
