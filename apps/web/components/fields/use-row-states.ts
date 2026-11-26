import type { StatusState } from "@anygriddb/core";
import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { useContext } from "react";
import { circuitWord } from "../record/circuit-labels";
import { useTableCircuit } from "../record/use-table-circuit";
import { TableContext } from "../table/table-context";

/**
 * A state a row can be in, by its key and its word for this reader, with
 * what it lets a row do (ADR 0124, 0137): the screens offer no more.
 */
export type RowStateChoice = {
  key: string;
  label: string;
  rules?: Pick<StatusState, "rowWritable" | "writableFields" | "allowDelete">;
};

/**
 * A table's states in its circuit's order, each by its circuit's word
 * (ADR 0133): read once by the table's page, which hands them down.
 */
export function useCircuitStates(tableId: string): readonly RowStateChoice[] {
  const { i18n } = useLingui();
  const circuit = useTableCircuit(tableId);
  return [...(circuit.data?.states ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((state) => ({
      key: state.key,
      label: circuitWord(i18n, "state", state),
      rules: {
        rowWritable: state.rowWritable,
        writableFields: state.writableFields,
        allowDelete: state.allowDelete,
      },
    }));
}

/**
 * The states of the table in view. Outside a table's page (a dashboard, a
 * shared view) none is known, and nothing is asked.
 */
export function useRowStates(): readonly RowStateChoice[] {
  return useContext(TableContext)?.states ?? [];
}

/** A state's word: its circuit's, else a shipped state's, else its key. */
export function rowStateWord(
  states: readonly RowStateChoice[],
  key: string,
  i18n: I18n,
): string {
  return (
    states.find((state) => state.key === key)?.label ??
    circuitWord(i18n, "state", { key })
  );
}
