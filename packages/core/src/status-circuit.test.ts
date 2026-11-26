import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import { assertCircuitDefinition } from "./schemas.js";
import {
  assertCircuitEdit,
  definitionOf,
  findAllowedTransition,
  initialState,
  stateAllows,
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
    madeRoleIds: [],
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
    shipped: [],
    made: [{ id: "m", name: "Made" }],
    permissions,
  });
  const to = (roleKeys: string[], madeRoleIds: string[] = []) => ({
    roleKeys,
    madeRoleIds,
  });

  it("opens a step to the roles it names, as before", () => {
    expect(takesTransition(to(["owner", "editor"]), "editor")).toBe(true);
    expect(takesTransition(to(["owner"]), "editor")).toBe(false);
    expect(takesTransition(to(["owner"]), null)).toBe(false);
    // A viewer takes no step, even one given to viewers: it takes none.
    expect(takesTransition(to(["viewer"]), "viewer")).toBe(false);
  });

  it("opens it to a made role that takes steps, by the act each of the four stands for", () => {
    const writes = made(["rows.read", "rows.write", "rows.transition"]);
    expect(takesTransition(to(["editor"]), writes)).toBe(true);
    expect(takesTransition(to(["owner"]), writes)).toBe(false);
    expect(
      takesTransition(
        to(["owner"]),
        made(["rows.read", "rows.lock", "rows.transition"]),
      ),
    ).toBe(true);
    // Writing without taking steps is not enough.
    expect(
      takesTransition(to(["editor"]), made(["rows.read", "rows.write"])),
    ).toBe(false);
  });

  it("opens it to a made role the step names, which neither writes nor locks", () => {
    const validates = made(["rows.read", "rows.transition"]);
    expect(takesTransition(to(["owner"], ["m"]), validates)).toBe(true);
    expect(takesTransition(to(["owner"], ["other"]), validates)).toBe(false);
    expect(takesTransition(to(["owner"], ["m"]), made(["rows.read"]))).toBe(
      false,
    );
  });
});

describe("a circuit as its editor saves it", () => {
  it("holds a circuit read back, its steps with whom they name", () => {
    const drawn = definitionOf(compliance);
    expect(() => assertCircuitDefinition(drawn)).not.toThrow();
    expect(drawn.steps.find((step) => step.key === "lock")).toMatchObject({
      from: "submitted",
      to: "locked",
      roles: ["owner"],
      madeRoles: [],
    });
  });

  it("refuses a circuit with no first state or two, a sealed state that writes, or a step to nowhere", () => {
    const drawn = definitionOf(compliance);
    const refused = (change: (copy: typeof drawn) => void) => {
      const copy = structuredClone(drawn);
      change(copy);
      try {
        assertCircuitDefinition(copy);
        return true;
      } catch {
        return false;
      }
    };
    expect(
      refused((copy) => {
        for (const state of copy.states) state.initial = true;
      }),
    ).toBe(false);
    expect(
      refused((copy) => {
        for (const state of copy.states) state.initial = false;
      }),
    ).toBe(false);
    expect(
      refused((copy) => {
        const sealed = copy.states.find((state) => state.seal);
        if (sealed) sealed.writable = true;
      }),
    ).toBe(false);
    expect(
      refused((copy) => {
        const first = copy.steps[0];
        if (first) first.to = "nowhere";
      }),
    ).toBe(false);
    expect(
      refused((copy) => {
        const first = copy.steps[0];
        if (first) copy.steps.push({ ...first });
      }),
    ).toBe(false);
  });
});

describe("what a state lets AnyGridDB write", () => {
  const state = (
    writable: boolean,
    fields: string[] | null,
    remove: boolean,
  ) => ({
    rowWritable: writable,
    writableFields: fields,
    allowDelete: remove,
  });

  it("lets a writable state change any field, or only those it names", () => {
    expect(stateAllows(state(true, null, true), { fields: ["a", "b"] })).toBe(
      true,
    );
    expect(stateAllows(state(true, ["a"], true), { fields: ["a"] })).toBe(true);
    expect(stateAllows(state(true, ["a"], true), { fields: ["a", "b"] })).toBe(
      false,
    );
  });

  it("refuses a change of a state that is not writable, and a delete it forbids", () => {
    expect(stateAllows(state(false, null, true), { fields: ["a"] })).toBe(
      false,
    );
    expect(stateAllows(state(false, null, true), { delete: true })).toBe(true);
    expect(stateAllows(state(true, null, false), { delete: true })).toBe(false);
  });
});
