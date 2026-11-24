import type { StatusCircuit } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canSubmitRow,
  statusSealed,
  statusShown,
} from "./row-status-model";

const compliance: StatusCircuit = {
  id: "c1",
  key: "compliance",
  name: "Compliance",
  system: false,
  tableId: "t1",
  states: [
    {
      id: "s1",
      key: "draft",
      label: "Draft",
      isInitial: true,
      rowWritable: true,
      writableFields: null,
      allowDelete: true,
      seal: false,
      position: 0,
    },
    {
      id: "s2",
      key: "submitted",
      label: "Submitted",
      isInitial: false,
      rowWritable: true,
      writableFields: null,
      allowDelete: true,
      seal: false,
      position: 1,
    },
    {
      id: "s3",
      key: "locked",
      label: "Locked",
      isInitial: false,
      rowWritable: false,
      writableFields: null,
      allowDelete: false,
      seal: true,
      position: 2,
    },
    {
      id: "s4",
      key: "signed",
      label: "Signed",
      isInitial: false,
      rowWritable: false,
      writableFields: null,
      allowDelete: false,
      seal: true,
      position: 3,
    },
  ],
  transitions: [
    {
      id: "tr1",
      key: "submit",
      label: "Submit",
      fromStateKey: "draft",
      toStateKey: "submitted",
      requireReason: false,
      requireFields: [],
      signature: "none",
      fourEyes: false,
      position: 0,
      roleKeys: ["editor", "owner"],
    },
    {
      id: "tr2",
      key: "lock",
      label: "Lock",
      fromStateKey: "submitted",
      toStateKey: "locked",
      requireReason: false,
      requireFields: [],
      signature: "none",
      fourEyes: false,
      position: 1,
      roleKeys: ["owner"],
    },
  ],
};

describe("statusShown", () => {
  it("shows the band once the review has begun", () => {
    expect(statusShown({ ag_status: "submitted" }, compliance)).toBe(true);
    expect(statusShown({ ag_status: "locked" }, compliance)).toBe(true);
    expect(statusShown({ ag_status: "signed" }, compliance)).toBe(true);
  });

  it("says nothing for the initial state or a row with no status", () => {
    expect(statusShown({ ag_status: "draft" }, compliance)).toBe(false);
    expect(statusShown({ ag_status: undefined }, compliance)).toBe(false);
  });

  it("falls back to draft when no circuit is given", () => {
    expect(statusShown({ ag_status: "submitted" })).toBe(true);
    expect(statusShown({ ag_status: "draft" })).toBe(false);
  });
});

describe("canSubmitRow", () => {
  it("offers an editor to submit a draft", () => {
    expect(canSubmitRow({ ag_status: "draft" }, "editor", compliance)).toBe(
      true,
    );
    expect(canSubmitRow({ ag_status: "draft" }, "owner", compliance)).toBe(
      true,
    );
  });

  it("offers nothing past the draft, or to a reader", () => {
    expect(canSubmitRow({ ag_status: "submitted" }, "owner", compliance)).toBe(
      false,
    );
    expect(canSubmitRow({ ag_status: "draft" }, "viewer", compliance)).toBe(
      false,
    );
  });
});

describe("allowedTransitions", () => {
  it("lists only what the role may take", () => {
    expect(
      allowedTransitions(compliance, "submitted", "owner").map(
        (item) => item.key,
      ),
    ).toEqual(["lock"]);
    expect(allowedTransitions(compliance, "submitted", "editor")).toEqual([]);
  });
});

describe("statusSealed", () => {
  it("reads seal from the circuit", () => {
    expect(statusSealed(compliance, "locked")).toBe(true);
    expect(statusSealed(compliance, "submitted")).toBe(false);
  });
});
