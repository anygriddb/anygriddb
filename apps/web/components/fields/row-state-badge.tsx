import { OptionBadge } from "@anygriddb/ui";
import { useLingui } from "@lingui/react";
import { rowStateWord, useRowStates } from "./use-row-states";

/** A row's state, by its circuit's word for it (ADR 0133). */
export function RowStateBadge({ stateKey }: { stateKey: string }) {
  const { i18n } = useLingui();
  const states = useRowStates();
  return <OptionBadge>{rowStateWord(states, stateKey, i18n)}</OptionBadge>;
}
