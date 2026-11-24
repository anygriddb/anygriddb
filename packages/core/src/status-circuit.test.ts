import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import {
  assertCircuitEdit,
  findAllowedTransition,
  initialState,
  transitionKeyForStatus,
  type StatusCircuit,
} from "./status-circuit.js";

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
    {
      id: "tr3",
      key: "unlock",
      label: "Unlock",
      fromStateKey: "locked",
      toStateKey: "draft",
      requireReason: false,
      requireFields: [],
      signature: "none",
      fourEyes: false,
      position: 2,
      roleKeys: ["owner"],
    },
  ],
};

describe("status circuit", () => {
  it("names the compliance transition for each former setStatus target", () => {
    expect(transitionKeyForStatus("submitted")).toBe("submit");
    expect(transitionKeyForStatus("locked")).toBe("lock");
    expect(transitionKeyForStatus("draft")).toBe("unlock");
  });

  it("accepts the transitions the compliance circuit grants", () => {
    expect(
      findAllowedTransition(compliance, "draft", "submit", "editor").toStateKey,
    ).toBe("submitted");
    expect(
      findAllowedTransition(compliance, "submitted", "lock", "owner")
        .toStateKey,
    ).toBe("locked");
    expect(() =>
      findAllowedTransition(compliance, "submitted", "lock", "editor"),
    ).toThrow(AppError);
  });

  it("names the initial state", () => {
    expect(initialState(compliance).key).toBe("draft");
  });

  it("refuses a circuit edit that would leave a row without a state", () => {
    expect(() =>
      assertCircuitEdit({
        remainingStateKeys: ["draft", "submitted"],
        initialKey: "draft",
        rowStatusCounts: { locked: 2 },
        removedKeys: ["locked"],
        remap: {},
      }),
    ).toThrow(AppError);
    expect(() =>
      assertCircuitEdit({
        remainingStateKeys: ["draft", "submitted"],
        initialKey: "draft",
        rowStatusCounts: { locked: 2 },
        removedKeys: ["locked"],
        remap: { locked: "submitted" },
      }),
    ).not.toThrow();
  });

  it("refuses removing the initial state without naming another", () => {
    expect(() =>
      assertCircuitEdit({
        remainingStateKeys: ["submitted"],
        initialKey: "draft",
        rowStatusCounts: {},
        removedKeys: ["draft"],
        remap: {},
      }),
    ).toThrow(AppError);
  });
});
