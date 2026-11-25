import type { CircuitDefinition } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  addState,
  addStep,
  keyFrom,
  makeInitial,
  removeState,
  setStateRules,
  statesToMove,
} from "./circuit-draft";

const empty: CircuitDefinition = { name: "Checks", states: [], steps: [] };

describe("a circuit's draft", () => {
  it("keys a state by its name, plain and unique", () => {
    expect(keyFrom("À vérifier", new Set(), "state")).toBe("a_verifier");
    expect(keyFrom("Done", new Set(["done"]), "state")).toBe("done_2");
    // A name of nothing a key keeps falls back.
    expect(keyFrom("— 1 —", new Set(), "state")).toBe("state");
  });

  it("makes its first state first, and a sealed state frozen", () => {
    let draft = addState(addState(empty, "Draft"), "Approved");
    expect(draft.states.map((state) => state.initial)).toEqual([true, false]);
    draft = setStateRules(draft, "approved", { seal: true });
    expect(draft.states[1]).toMatchObject({
      seal: true,
      writable: false,
      delete: false,
    });
    draft = makeInitial(draft, "approved");
    expect(draft.states.map((state) => state.initial)).toEqual([false, true]);
  });

  it("drops the steps of a state it drops, and keeps one state first", () => {
    let draft = addState(addState(empty, "Draft"), "Approved");
    draft = addStep(draft, "Approve");
    expect(draft.steps[0]).toMatchObject({
      key: "approve",
      from: "draft",
      to: "approved",
      roles: ["owner", "editor"],
    });
    draft = removeState(draft, "draft");
    expect(draft.steps).toEqual([]);
    expect(draft.states).toMatchObject([{ key: "approved", initial: true }]);
    // No step without two states to go between.
    expect(addStep(draft, "Nowhere").steps).toEqual([]);
  });

  it("says which states going leave rows to move, and how many", () => {
    const draft = addState(empty, "Draft");
    expect(
      statesToMove(
        [
          { key: "draft", label: "Draft" },
          { key: "submitted", label: "Submitted" },
          { key: "locked", label: "Locked" },
        ],
        draft,
        { draft: 3, submitted: 2 },
      ),
    ).toEqual([{ key: "submitted", label: "Submitted", rows: 2 }]);
  });
});
