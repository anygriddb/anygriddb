import type { CircuitDefinition } from "@anygriddb/core";

export type DraftState = CircuitDefinition["states"][number];
export type DraftStep = CircuitDefinition["steps"][number];

/**
 * A key a new state or step is stored under, made of its name: letters
 * without their accents, digits and underscores, starting with a letter,
 * and not one the circuit already has.
 */
export function keyFrom(
  label: string,
  taken: ReadonlySet<string>,
  fallback: string,
): string {
  // Words of letters and digits, joined by one underscore, from the first
  // that starts with a letter: no quantifier the lint finds slow.
  const words = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter((word) => word !== "");
  const start = words.findIndex((word) => /^[a-z]/.test(word));
  const plain =
    start === -1 ? fallback : words.slice(start).join("_").slice(0, 48);
  let key = plain;
  for (let n = 2; taken.has(key); n += 1) key = `${plain}_${n}`;
  return key;
}

/** A new state, writable and deletable, after the others. */
export function addState(
  draft: CircuitDefinition,
  label: string,
): CircuitDefinition {
  const key = keyFrom(
    label,
    new Set(draft.states.map((state) => state.key)),
    "state",
  );
  return {
    ...draft,
    states: [
      ...draft.states,
      {
        key,
        label,
        initial: draft.states.length === 0,
        writable: true,
        writableFields: null,
        delete: true,
        seal: false,
      },
    ],
  };
}

/**
 * The circuit without a state, and without the steps that led to it or
 * left it. Removing the first state makes the next one first.
 */
export function removeState(
  draft: CircuitDefinition,
  key: string,
): CircuitDefinition {
  const states = draft.states.filter((state) => state.key !== key);
  const first = states.some((state) => state.initial);
  return {
    ...draft,
    states: states.map((state, index) =>
      first ? state : { ...state, initial: index === 0 },
    ),
    steps: draft.steps.filter((step) => step.from !== key && step.to !== key),
  };
}

/** One state first, the others not. */
export function makeInitial(
  draft: CircuitDefinition,
  key: string,
): CircuitDefinition {
  return {
    ...draft,
    states: draft.states.map((state) => ({
      ...state,
      initial: state.key === key,
    })),
  };
}

/** A state's rules: a sealed state neither writes nor deletes. */
export function setStateRules(
  draft: CircuitDefinition,
  key: string,
  rules: Partial<Pick<DraftState, "writable" | "delete" | "seal" | "label">>,
): CircuitDefinition {
  return {
    ...draft,
    states: draft.states.map((state) => {
      if (state.key !== key) return state;
      const next = { ...state, ...rules };
      return next.seal ? { ...next, writable: false, delete: false } : next;
    }),
  };
}

/** A new step between the first two states, taken by owners and editors. */
export function addStep(
  draft: CircuitDefinition,
  label: string,
): CircuitDefinition {
  const [from, to] = draft.states;
  if (!from || !to) return draft;
  const key = keyFrom(
    label,
    new Set(
      draft.steps.filter((step) => step.from === from.key).map((s) => s.key),
    ),
    "step",
  );
  return {
    ...draft,
    steps: [
      ...draft.steps,
      {
        key,
        label,
        from: from.key,
        to: to.key,
        reason: false,
        fields: [],
        signature: "none",
        fourEyes: false,
        roles: ["owner", "editor"],
        madeRoles: [],
      },
    ],
  };
}

/** The states rows are in that the draft no longer has, with their count. */
export function statesToMove(
  saved: readonly { key: string; label: string }[],
  draft: CircuitDefinition,
  counts: Readonly<Record<string, number>>,
): Array<{ key: string; label: string; rows: number }> {
  const kept = new Set(draft.states.map((state) => state.key));
  return saved
    .filter((state) => !kept.has(state.key) && (counts[state.key] ?? 0) > 0)
    .map((state) => ({ ...state, rows: counts[state.key] ?? 0 }));
}
