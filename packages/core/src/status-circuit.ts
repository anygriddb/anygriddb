import { AppError } from "./errors.js";
import {
  type Grant,
  type Permission,
  type Role,
  ROLES,
  roleGrants,
} from "./rbac.js";

/** Signature proof a transition may require (ADR 0124). */
export type TransitionSignature = "none" | "password" | "step_up";

export type StatusState = {
  id: string;
  key: string;
  label: string;
  isInitial: boolean;
  rowWritable: boolean;
  writableFields: string[] | null;
  allowDelete: boolean;
  seal: boolean;
  position: number;
};

export type StatusTransition = {
  id: string;
  key: string;
  label: string;
  fromStateKey: string;
  toStateKey: string;
  requireReason: boolean;
  requireFields: string[];
  signature: TransitionSignature;
  fourEyes: boolean;
  position: number;
  /** The four roles that may take it, by their keys. */
  roleKeys: string[];
  /** The made roles that may take it (ADR 0130). */
  madeRoleIds: string[];
};

export type StatusCircuit = {
  id: string;
  key: string;
  name: string;
  system: boolean;
  tableId: string | null;
  states: StatusState[];
  transitions: StatusTransition[];
};

export const SHIPPED_CIRCUIT_KEYS = [
  "compliance",
  "simple_review",
  "dual_approval",
] as const;

export type ShippedCircuitKey = (typeof SHIPPED_CIRCUIT_KEYS)[number];

/** Maps the former setStatus targets to compliance transition keys. */
export function transitionKeyForStatus(
  to: "submitted" | "locked" | "draft",
): "submit" | "lock" | "unlock" {
  if (to === "submitted") return "submit";
  if (to === "locked") return "lock";
  return "unlock";
}

export function initialState(circuit: StatusCircuit): StatusState {
  const state = circuit.states.find((item) => item.isInitial);
  if (!state) {
    throw new AppError("invalid_status");
  }
  return state;
}

export function stateByKey(
  circuit: StatusCircuit,
  key: string,
): StatusState | undefined {
  return circuit.states.find((item) => item.key === key);
}

/**
 * The step a row took between two states, as the circuit names it: the
 * first of its steps from one to the other, or null.
 */
export function stepBetween(
  circuit: StatusCircuit,
  from: string,
  to: string,
): StatusTransition | null {
  return (
    [...circuit.transitions]
      .sort((a, b) => a.position - b.position)
      .find((item) => item.fromStateKey === from && item.toStateKey === to) ??
    null
  );
}

export function transitionsFrom(
  circuit: StatusCircuit,
  fromKey: string,
): StatusTransition[] {
  return circuit.transitions.filter((item) => item.fromStateKey === fromKey);
}

/**
 * Finds the transition the actor may take from `fromKey` with `transitionKey`.
 * Role must be listed on the transition (owner may take any grant that lists
 * owner; the former ladder is expressed in the circuit grants).
 */
/**
 * The act that stands for each of the four in a circuit's grants, for a
 * made role (ADR 0128): a transition given to editors is open to a made
 * role that writes rows, one given to owners to a made role that locks
 * them.
 */
const ACT_OF_KEY: Record<Role, Permission> = {
  viewer: "rows.read",
  commenter: "rows.comment",
  editor: "rows.write",
  owner: "rows.lock",
};

/**
 * Whether what applies on a table may take a step: it takes steps at all
 * (`rows.transition`), and the step names its role, one of the four or a
 * made role it holds, or one of the four by the act that stands for it.
 */
export function takesTransition(
  step: Pick<StatusTransition, "roleKeys" | "madeRoleIds">,
  grant: Grant | null | undefined,
): boolean {
  if (grant == null || !roleGrants(grant, "rows.transition")) return false;
  if (typeof grant === "string") return step.roleKeys.includes(grant);
  if (grant.role !== null && step.roleKeys.includes(grant.role)) return true;
  if (grant.made.some((made) => step.madeRoleIds.includes(made.id))) {
    return true;
  }
  return step.roleKeys.some(
    (key) =>
      (ROLES as readonly string[]).includes(key) &&
      roleGrants(grant, ACT_OF_KEY[key as Role]),
  );
}

export function findAllowedTransition(
  circuit: StatusCircuit,
  fromKey: string,
  transitionKey: string,
  grant: Grant,
): StatusTransition {
  const match = circuit.transitions.find(
    (item) =>
      item.fromStateKey === fromKey &&
      item.key === transitionKey &&
      takesTransition(item, grant),
  );
  if (!match) {
    throw new AppError("invalid_status");
  }
  return match;
}

/**
 * Refuses a circuit edit that would leave a row without a state, or remove
 * the only / initial state without a replacement.
 */
export function assertCircuitEdit(input: {
  remainingStateKeys: readonly string[];
  initialKey: string;
  rowStatusCounts: Readonly<Record<string, number>>;
  removedKeys: readonly string[];
  remap: Readonly<Record<string, string>>;
}): void {
  if (input.remainingStateKeys.length === 0) {
    throw new AppError("invalid_status");
  }
  if (!input.remainingStateKeys.includes(input.initialKey)) {
    throw new AppError("invalid_status");
  }
  const remaining = new Set(input.remainingStateKeys);
  for (const key of input.removedKeys) {
    const count = input.rowStatusCounts[key] ?? 0;
    if (count === 0) continue;
    const target = input.remap[key];
    if (!target || !remaining.has(target)) {
      throw new AppError("invalid_status");
    }
  }
  for (const [from, to] of Object.entries(input.remap)) {
    if (!input.removedKeys.includes(from) || !remaining.has(to)) {
      throw new AppError("invalid_status");
    }
  }
}
