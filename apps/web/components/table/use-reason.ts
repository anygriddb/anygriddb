import { useCallback, useMemo, useState } from "react";
import type { CatalogColumn } from "../../lib/types";
import { StepGivenUp } from "../../lib/undo-stack";

/**
 * Why a change is made: the reason given, nothing where no field touched
 * asks for one, and `false` when the person gave none, which gives the
 * change up.
 */
export type ReasonAnswer = string | undefined | false;

/**
 * Asks why, where a field wants a reason for every change. One question
 * at a time: the page shows it (`ReasonDialog`) and hands the answer back.
 */
export function useReason(columns: readonly CatalogColumn[]) {
  const [pending, setPending] = useState<{
    resolve: (reason: string | false) => void;
  } | null>(null);

  const ask = useCallback(
    (touched: readonly string[]) =>
      new Promise<ReasonAnswer>((resolve) => {
        if (
          !columns.some(
            (column) => column.requireReason && touched.includes(column.name),
          )
        ) {
          resolve(undefined);
          return;
        }
        setPending({ resolve });
      }),
    [columns],
  );

  // A row deleted or brought back changes every field it holds.
  const everyField = useMemo(
    () =>
      columns
        .filter((column) => column.requireReason)
        .map((column) => column.name),
    [columns],
  );

  // The reason of a step undone or redone: given up, the step stays where
  // it was, to be tried again.
  const askForStep = useCallback(
    async (touched: readonly string[]) => {
      const reason = await ask(touched);
      if (reason === false) throw new StepGivenUp();
      return reason;
    },
    [ask],
  );

  const answer = useCallback(
    (reason: string | false) => {
      pending?.resolve(reason);
      setPending(null);
    },
    [pending],
  );

  return { ask, askForStep, everyField, asking: pending !== null, answer };
}

export type Reason = ReturnType<typeof useReason>;
