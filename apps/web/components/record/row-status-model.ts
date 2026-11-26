import {
  initialState,
  stateAllows,
  stateByKey,
  transitionsFrom,
  type StatusCircuit,
  type StatusTransition,
} from "@anygriddb/core";
import { takesTransition } from "@anygriddb/core";
import { grants, type Grant } from "../../lib/types";
import type { RowStateChoice } from "../fields/use-row-states";

/** A row as these rules read it: its status column, when it has one. */
type WithStatus = Readonly<Record<string, unknown>>;

const LEGACY_INITIAL = "draft";

function circuitInitial(circuit: StatusCircuit | undefined): string {
  return circuit ? initialState(circuit).key : LEGACY_INITIAL;
}

/**
 * Whether a row's panel shows its status band: once it has left the
 * circuit's initial state (compliance: draft). Rows with no status stay
 * hidden.
 */
export function statusShown(
  row: WithStatus,
  circuit?: StatusCircuit | null,
): boolean {
  if (typeof row.ag_status !== "string") return false;
  return row.ag_status !== circuitInitial(circuit ?? undefined);
}

/** Transitions the role may take from `fromKey`, in circuit order. */
export function allowedTransitions(
  circuit: StatusCircuit,
  fromKey: string,
  role: Grant | null,
): StatusTransition[] {
  return transitionsFrom(circuit, fromKey)
    .filter((item) => takesTransition(item, role))
    .sort((a, b) => a.position - b.position);
}

/** Whether the row's panel offers to submit it, from its menu. */
export function canSubmitRow(
  row: WithStatus,
  role: Grant | null,
  circuit?: StatusCircuit | null,
): boolean {
  if (!grants(role, "rows.transition")) return false;
  if (typeof row.ag_status !== "string") return false;
  const initial = circuitInitial(circuit ?? undefined);
  if (row.ag_status !== initial) return false;
  if (circuit) {
    return allowedTransitions(circuit, initial, role).length > 0;
  }
  return true;
}

/** The first transition an editor or owner may take from the initial state. */
export function submitTransition(
  circuit: StatusCircuit,
  role: Grant | null,
): StatusTransition | undefined {
  return allowedTransitions(circuit, initialState(circuit).key, role)[0];
}

/** Whether the row's status is a sealed state on its circuit. */
export function statusSealed(
  circuit: StatusCircuit | null | undefined,
  status: string,
): boolean {
  if (circuit) {
    return stateByKey(circuit, status)?.seal === true;
  }
  return status === "locked" || status === "signed";
}

/**
 * Whether a row's state lets these of its fields change, or the row go, as
 * the server holds it (ADR 0124, 0137): a screen offers no more. A row of
 * a table whose states are not read yet is held to compliance's words.
 */
export function rowLets(
  row: WithStatus,
  states: readonly RowStateChoice[],
  act: { delete: true } | { fields: readonly string[] },
): boolean {
  const key = row.ag_status;
  if (typeof key !== "string") return true;
  const rules = states.find((state) => state.key === key)?.rules;
  if (!rules) return key !== "locked" && key !== "signed";
  return stateAllows(rules, act);
}
