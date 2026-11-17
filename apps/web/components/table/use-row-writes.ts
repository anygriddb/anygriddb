import type { FilterGroup } from "@anygriddb/core";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import type { RowPlace } from "../../lib/row-place";
import { trpc } from "../../lib/trpc";
import type { CatalogColumn, RowItem } from "../../lib/types";
import type { RowsState } from "../grid/use-rows";
import { useUndo } from "../grid/use-undo";
import {
  lastInOrder,
  linkedIds,
  rowCopies,
  touchedFields,
  valuesBefore,
  writeValues,
  type CellUpdate,
} from "./row-writes";
import type { CellValue } from "./table-context";
import type { Reason } from "./use-reason";
import { prefillFromFilter } from "./view-read";

/** A page of rows is written this many at a time. */
const WRITE_BATCH = 500;

/** A promise settled from outside: a save's outcome, known later. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Every change a table's page makes to its rows: cells and links written,
 * rows added, copied, deleted, and moved. A change shows at once and is
 * saved behind it; each can be undone and redone, asks for a reason where
 * a field wants one, and says when the server refuses it.
 */
export function useRowWrites(input: {
  tableId: string;
  columns: readonly CatalogColumn[];
  rows: RowsState;
  rowsById: ReadonlyMap<string, RowItem>;
  /**
   * A client's table: a change is checked against what the person saw
   * (ADR 0006), and a row deleted there has no trash to come back from.
   */
  external: boolean;
  /** A kanban's stacks: a card changed may belong to another stack. */
  stacked: boolean;
  /** Rows keep the order given by hand: a copy goes under its row. */
  byHand: boolean;
  /** The view's filter: a new row takes the values it asks for. */
  filter: FilterGroup | undefined;
  reason: Reason;
}) {
  const { tableId, columns, rows, rowsById, external, stacked, byHand } = input;
  const { ask, askForStep, everyField } = input.reason;
  const { t } = useLingui();
  const errorText = useErrorText();
  const { push, undo, redo, canUndo, canRedo } = useUndo();
  // When the last write reached the database: the toolbar says so.
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");

  /**
   * Shows a change of cells at once and saves it behind. Refused, the rows
   * go back to what they held, and the page says why. Says whether it was
   * saved.
   */
  const saveCells = useCallback(
    async (
      updates: CellUpdate[],
      previous: CellUpdate[],
      reason: string | undefined,
    ): Promise<boolean> => {
      const rowIds = updates.map((update) => update.rowId);
      for (const update of updates)
        rows.patchLocal(update.rowId, update.values);
      // Until the save answers, a read made elsewhere may still hold the
      // rows as they were: it must not put that back under an open editor.
      const release = rows.holdRows(rowIds);
      setSaveStatus("saving");
      // A client's table compares what the person saw with what its row
      // holds now, and refuses the change if it moved (ADR 0006).
      const sent = updates.map((update, index) =>
        external
          ? { ...update, expected: previous[index]?.values ?? {} }
          : update,
      );
      try {
        for (let index = 0; index < sent.length; index += WRITE_BATCH) {
          await trpc.rows.updateMany.mutate({
            tableId,
            updates: sent.slice(index, index + WRITE_BATCH),
            reason,
          });
        }
        release();
        // A card moved to another stack moves where every stack starts.
        if (stacked) rows.refresh();
        else void rows.refetchIds(rowIds);
        setSavedAt(new Date());
        setSaveStatus("saved");
        return true;
      } catch (cause) {
        for (const update of previous)
          rows.patchLocal(update.rowId, update.values);
        release();
        // What the rows hold now, which may not be what was shown.
        void rows.refetchIds(rowIds);
        setSaveStatus("error");
        toast.error(errorText(cause));
        return false;
      }
    },
    [rows, tableId, errorText, external, stacked],
  );

  /**
   * A change of cells undone or redone: written again, with the reason it
   * needs, and not kept a second time.
   */
  const replayCells = useCallback(
    async (given: CellUpdate[]) => {
      const updates = writeValues(given, columns);
      const reason = await askForStep(touchedFields(updates));
      await saveCells(updates, valuesBefore(updates, rowsById), reason);
    },
    [columns, askForStep, saveCells, rowsById],
  );

  const updateCells = useCallback(
    async (given: CellUpdate[]): Promise<void> => {
      if (given.length === 0) return;
      const updates = writeValues(given, columns);
      const reason = await ask(touchedFields(updates));
      if (reason === false) return;
      const previous = valuesBefore(updates, rowsById);
      // Kept as soon as it is sent: an undo right away waits for the save.
      const saved = deferred<boolean>();
      push({
        label: t`Edit`,
        undo: () => replayCells(previous),
        redo: () => replayCells(updates),
        settled: saved.promise,
      });
      saved.resolve(await saveCells(updates, previous, reason));
    },
    [ask, columns, rowsById, t, push, saveCells, replayCells],
  );

  /** Sets a link cell's rows; says whether the server took them. */
  const saveLinks = useCallback(
    async (
      rowId: string,
      column: string,
      targetIds: string[],
      reason: string | undefined,
    ): Promise<boolean> => {
      try {
        await trpc.rows.setLinks.mutate({
          tableId,
          rowId,
          column,
          targetIds,
          reason,
        });
        await rows.refetchIds([rowId]);
        return true;
      } catch (cause) {
        toast.error(errorText(cause));
        return false;
      }
    },
    [tableId, rows, errorText],
  );

  /** A change of links undone or redone, with the reason it needs. */
  const replayLinks = useCallback(
    async (rowId: string, column: string, targetIds: string[]) => {
      const reason = await askForStep([column]);
      await saveLinks(rowId, column, targetIds, reason);
    },
    [askForStep, saveLinks],
  );

  const setLinks = useCallback(
    async (
      rowId: string,
      column: string,
      targetIds: string[],
    ): Promise<void> => {
      const reason = await ask([column]);
      if (reason === false) return;
      const previous = linkedIds(
        rowsById.get(rowId)?.[column as keyof RowItem],
      );
      const saved = deferred<boolean>();
      push({
        label: t`Edit`,
        undo: () => replayLinks(rowId, column, previous),
        redo: () => replayLinks(rowId, column, targetIds),
        settled: saved.promise,
      });
      saved.resolve(await saveLinks(rowId, column, targetIds, reason));
    },
    [rowsById, ask, push, t, saveLinks, replayLinks],
  );

  /** Deletes rows as a step undone or redone, with the reason it needs. */
  const removeAsStep = useCallback(
    async (rowIds: string[]) => {
      const reason = await askForStep(everyField);
      await trpc.rows.deleteMany.mutate({ tableId, rowIds, reason });
      rows.refresh();
    },
    [askForStep, everyField, tableId, rows],
  );

  /** Brings rows back as a step undone or redone, with its reason. */
  const restoreAsStep = useCallback(
    async (rowIds: string[]) => {
      const reason = await askForStep(everyField);
      await trpc.rows.restore.mutate({ tableId, rowIds, reason });
      rows.refresh();
    },
    [askForStep, everyField, tableId, rows],
  );

  const insertRows = useCallback(
    async (
      list: Array<Record<string, CellValue>>,
      track = true,
      place?: RowPlace,
    ): Promise<string[]> => {
      // A client's row has no trash to come back from: no undo there.
      const undoable = track && !external;
      try {
        const reason = await ask([
          ...new Set(list.flatMap((values) => Object.keys(values))),
        ]);
        if (reason === false) return [];
        const created = await trpc.rows.insertMany.mutate({
          tableId,
          rows: list,
          reason,
          place,
        });
        rows.refresh();
        setSavedAt(new Date());
        setSaveStatus("saved");
        if (undoable) {
          push({
            label: t`Insert`,
            undo: () => removeAsStep(created.ids),
            redo: () => restoreAsStep(created.ids),
          });
        }
        return created.ids;
      } catch (cause) {
        setSaveStatus("error");
        toast.error(errorText(cause));
        return [];
      }
    },
    [
      tableId,
      rows,
      push,
      t,
      ask,
      removeAsStep,
      restoreAsStep,
      errorText,
      external,
    ],
  );

  const deleteRows = useCallback(
    async (rowIds: string[]) => {
      if (rowIds.length === 0) return;
      try {
        const reason = await ask(everyField);
        if (reason === false) return;
        await trpc.rows.deleteMany.mutate({ tableId, rowIds, reason });
        rows.refresh();
        setSavedAt(new Date());
        setSaveStatus("saved");
        if (external) {
          // Deleted in the client's database: nothing to restore from.
          toast.success(
            plural(rowIds.length, {
              one: `# row deleted from the client's database`,
              other: `# rows deleted from the client's database`,
            }),
          );
          return;
        }
        toast.success(
          plural(rowIds.length, {
            one: "# row deleted",
            other: "# rows deleted",
          }),
          {
            action: {
              label: t`Cancel`,
              onClick: () => {
                void (async () => {
                  const back = await ask(everyField);
                  if (back === false) return;
                  await trpc.rows.restore.mutate({
                    tableId,
                    rowIds,
                    reason: back,
                  });
                  rows.refresh();
                })().catch((cause: unknown) => toast.error(errorText(cause)));
              },
            },
          },
        );
        push({
          label: t`Delete`,
          undo: () => restoreAsStep(rowIds),
          redo: () => removeAsStep(rowIds),
        });
      } catch (cause) {
        setSaveStatus("error");
        toast.error(errorText(cause));
      }
    },
    [
      tableId,
      rows,
      push,
      t,
      ask,
      everyField,
      removeAsStep,
      restoreAsStep,
      errorText,
      external,
    ],
  );

  const duplicateRows = useCallback(
    async (rowIds: string[]) => {
      // The copies go under the last row copied, where rows keep an order
      // of their own; at the end otherwise.
      const last = lastInOrder(rowIds, rows.loadedRows());
      const list = rowCopies(rowIds, rowsById, columns);
      if (list.length > 0) {
        await insertRows(
          list,
          true,
          byHand && last ? { after: last } : undefined,
        );
      }
    },
    [rowsById, rows, columns, insertRows, byHand],
  );

  const addRow = useCallback(
    async (
      values: Record<string, unknown> = {},
      place?: RowPlace,
    ): Promise<string | undefined> => {
      const ids = await insertRows(
        [
          {
            ...prefillFromFilter(input.filter, columns),
            ...(values as Record<string, CellValue>),
          },
        ],
        true,
        place,
      );
      return ids[0];
    },
    [insertRows, input.filter, columns],
  );

  // Rows put beside another by hand; undone by putting them back beside
  // the row they followed.
  const moveRows = useCallback(
    async (rowIds: string[], place: RowPlace, back: RowPlace | null) => {
      const move = async (to: RowPlace) => {
        await trpc.rows.move.mutate({ tableId, rowIds, place: to });
        rows.refresh();
      };
      try {
        await move(place);
        setSavedAt(new Date());
        setSaveStatus("saved");
        if (back) {
          push({
            label: t`Move`,
            undo: () => move(back),
            redo: () => move(place),
          });
        }
      } catch (cause) {
        setSaveStatus("error");
        toast.error(errorText(cause));
      }
    },
    [tableId, rows, push, t, errorText],
  );

  // A step that cannot be undone or redone says why.
  const undoLast = useCallback(() => {
    void undo().catch((cause: unknown) => toast.error(errorText(cause)));
  }, [undo, errorText]);
  const redoLast = useCallback(() => {
    void redo().catch((cause: unknown) => toast.error(errorText(cause)));
  }, [redo, errorText]);

  return {
    updateCells,
    setLinks,
    insertRows,
    deleteRows,
    duplicateRows,
    addRow,
    moveRows,
    undo: undoLast,
    redo: redoLast,
    canUndo,
    canRedo,
    savedAt,
    saveStatus,
  };
}
