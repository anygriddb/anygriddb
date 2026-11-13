import { describe, expect, it } from "vitest";
import { canSubmitRow, statusShown } from "./row-status-model";

describe("statusShown", () => {
  it("shows the band once the review has begun", () => {
    expect(statusShown({ ag_status: "submitted" })).toBe(true);
    expect(statusShown({ ag_status: "locked" })).toBe(true);
    expect(statusShown({ ag_status: "signed" })).toBe(true);
  });

  it("says nothing for a draft or a row with no status", () => {
    expect(statusShown({ ag_status: "draft" })).toBe(false);
    expect(statusShown({ ag_status: undefined })).toBe(false);
  });
});

describe("canSubmitRow", () => {
  it("offers an editor to submit a draft", () => {
    expect(canSubmitRow({ ag_status: "draft" }, "editor")).toBe(true);
    expect(canSubmitRow({ ag_status: "draft" }, "owner")).toBe(true);
  });

  it("offers nothing past the draft, or to a reader", () => {
    expect(canSubmitRow({ ag_status: "submitted" }, "owner")).toBe(false);
    expect(canSubmitRow({ ag_status: "draft" }, "viewer")).toBe(false);
  });
});
