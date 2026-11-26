import type {
  Permission,
  StatusCircuit,
  StatusState,
  StatusTransition,
} from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  canSubmitRow,
  rowLets,
  statusSealed,
  statusShown,
} from "./row-status-model";

/** A state as the circuit's tests need it: sealed or not. */
function state(key: string, position: number, sealed = false): StatusState {
  return {
    id: key,
    key,
    label: key,
    isInitial: position === 0,
    rowWritable: !sealed,
    writableFields: null,
    allowDelete: !sealed,
    seal: sealed,
    position,
  };
}

/** A move between two states, open to the roles named. */
function move(
  key: string,
  [fromStateKey, toStateKey]: [string, string],
  roleKeys: string[],
): StatusTransition {
  return {
    id: key,
    key,
    label: key,
    fromStateKey,
    toStateKey,
    requireReason: false,
    requireFields: [],
    signature: "none",
    fourEyes: false,
    position: 0,
    roleKeys,
    madeRoleIds: [],
  };
}

const compliance: StatusCircuit = {
  id: "c1",
  key: "compliance",
  name: "Compliance",
  system: false,
  tableId: "t1",
  states: [
    state("draft", 0),
    state("submitted", 1),
    state("locked", 2, true),
    state("signed", 3, true),
  ],
  transitions: [
    move("submit", ["draft", "submitted"], ["editor", "owner"]),
    move("lock", ["submitted", "locked"], ["owner"]),
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

  it("offers a step to a made role it names, which neither writes nor locks", () => {
    const named: StatusCircuit = {
      ...compliance,
      transitions: compliance.transitions.map((item) =>
        item.key === "lock" ? { ...item, madeRoleIds: ["v"] } : item,
      ),
    };
    const validator = {
      role: null,
      shipped: [],
      made: [{ id: "v", name: "Validator" }],
      permissions: ["rows.read", "rows.transition"] as Permission[],
    };
    expect(
      allowedTransitions(named, "submitted", validator).map((item) => item.key),
    ).toEqual(["lock"]);
    expect(allowedTransitions(compliance, "submitted", validator)).toEqual([]);
  });
});

describe("statusSealed", () => {
  it("reads seal from the circuit", () => {
    expect(statusSealed(compliance, "locked")).toBe(true);
    expect(statusSealed(compliance, "submitted")).toBe(false);
  });
});

describe("what a row's state lets the screens offer", () => {
  const states = [
    {
      key: "draft",
      label: "Draft",
      rules: { rowWritable: true, writableFields: null, allowDelete: true },
    },
    {
      key: "in_review",
      label: "In review",
      rules: {
        rowWritable: true,
        writableFields: ["note"],
        allowDelete: false,
      },
    },
    {
      key: "approved",
      label: "Approved",
      rules: { rowWritable: false, writableFields: null, allowDelete: false },
    },
  ];

  it("offers what the state lets change, and the delete it allows", () => {
    expect(
      rowLets({ ag_status: "draft" }, states, { fields: ["amount"] }),
    ).toBe(true);
    expect(
      rowLets({ ag_status: "in_review" }, states, { fields: ["note"] }),
    ).toBe(true);
    expect(rowLets({ ag_status: "draft" }, states, { delete: true })).toBe(
      true,
    );
    expect(rowLets({}, states, { fields: ["amount"] })).toBe(true);
  });

  it("holds back what a state forbids, compliance's words before the states are read", () => {
    expect(
      rowLets({ ag_status: "in_review" }, states, { fields: ["amount"] }),
    ).toBe(false);
    expect(rowLets({ ag_status: "in_review" }, states, { delete: true })).toBe(
      false,
    );
    expect(rowLets({ ag_status: "approved" }, states, { fields: [] })).toBe(
      false,
    );
    expect(rowLets({ ag_status: "locked" }, [], { fields: ["amount"] })).toBe(
      false,
    );
    expect(
      rowLets({ ag_status: "submitted" }, [], { fields: ["amount"] }),
    ).toBe(true);
  });
});
