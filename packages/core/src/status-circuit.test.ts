import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import {
  assertCircuitEdit,
  findAllowedTransition,
  initialState,
  takesTransition,
  transitionKeyForStatus,
  type StatusCircuit,
} from "./status-circuit.js";
import type { Permission } from "./rbac.js";

/** Compliance's first three states, the last one sealed. */
const compliance: StatusCircuit = {
  id: "c1",
  key: "compliance",
  name: "Compliance",
  system: false,
  tableId: "t1",
  states: (
    [
      ["draft", false],
      ["submitted", false],
      ["locked", true],
    ] as const
  ).map(([key, sealed], position) => ({
    id: `s-${key}`,
    key,
    label: key,
    isInitial: position === 0,
    rowWritable: !sealed,
    writableFields: null,
    allowDelete: !sealed,
    seal: sealed,
    position,
  })),
  transitions: (
    [
      ["submit", "draft", "submitted", ["editor", "owner"]],
      ["lock", "submitted", "locked", ["owner"]],
      ["unlock", "locked", "draft", ["owner"]],
    ] as const
  ).map(([key, fromStateKey, toStateKey, roleKeys], position) => ({
    id: `t-${key}`,
    key,
    label: key,
    fromStateKey,
    toStateKey,
    requireReason: false,
    requireFields: [],
    signature: "none" as const,
    fourEyes: false,
    position,
    roleKeys: [...roleKeys],
  })),
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

describe("takesTransition", () => {
  const made = (permissions: Permission[]) => ({
    role: null,
    made: [{ id: "m", name: "Made" }],
    permissions,
  });

  it("opens a transition to the roles it names, as before", () => {
    expect(takesTransition(["owner", "editor"], "editor")).toBe(true);
    expect(takesTransition(["owner"], "editor")).toBe(false);
    expect(takesTransition(["owner"], null)).toBe(false);
  });

  it("opens it to a made role by the act each of the four stands for", () => {
    expect(takesTransition(["editor"], made(["rows.read", "rows.write"]))).toBe(
      true,
    );
    expect(takesTransition(["owner"], made(["rows.read", "rows.write"]))).toBe(
      false,
    );
    expect(takesTransition(["owner"], made(["rows.read", "rows.lock"]))).toBe(
      true,
    );
    expect(takesTransition(["reviewer"], made(["rows.read"]))).toBe(false);
  });
});
