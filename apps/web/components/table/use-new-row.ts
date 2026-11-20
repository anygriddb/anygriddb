import { useCallback, useState } from "react";
import type { RowPlace } from "../../lib/row-place";

/**
 * How a new row starts. A client's table checks a new row as a whole, and
 * a table with a required field refuses an empty one: there the row is
 * filled first, in a dialog. Any other row of AnyGridDB's own starts
 * empty, and is filled where it lands.
 */
export function useNewRow(input: {
  /** The row is filled before it is added. */
  fillFirst: boolean;
  addRow: (
    values?: Record<string, unknown>,
    place?: RowPlace,
  ) => Promise<string | undefined>;
  /** Opens a row's panel. */
  openRecord: (rowId: string) => void;
  /** What the view gives a row added from its bar, so that it shows it. */
  start: () => Record<string, unknown>;
}) {
  const { fillFirst, addRow, openRecord, start } = input;
  // What the row being filled already holds; null while none is.
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  // Where it goes, when it was asked for above or below another.
  const [place, setPlace] = useState<RowPlace | undefined>();

  /** A new row, opened in its panel: the toolbar's button. */
  const addAndOpen = useCallback(() => {
    const known = start();
    if (fillFirst) {
      setValues(known);
      return;
    }
    void addRow(known).then((id) => {
      if (id) openRecord(id);
    });
  }, [fillFirst, addRow, openRecord, start]);

  /** A new row at the end of the grid: its last line. */
  const addInGrid = useCallback(async () => {
    if (fillFirst) {
      setPlace(undefined);
      setValues({});
      return;
    }
    // The new row appears in the grid: that is the confirmation.
    await addRow();
  }, [fillFirst, addRow]);

  /** A new row just above or below another: a row's menu. */
  const addBeside = useCallback(
    async (beside: RowPlace) => {
      if (fillFirst) {
        setPlace(beside);
        setValues({});
        return;
      }
      await addRow({}, beside);
    },
    [fillFirst, addRow],
  );

  /**
   * A new row that already holds something: a card added to a stack, a
   * day clicked in a calendar.
   */
  const addWith = useCallback(
    (known: Record<string, unknown>): Promise<string | undefined> => {
      if (fillFirst) {
        setValues(known);
        return Promise.resolve(undefined);
      }
      return addRow(known);
    },
    [fillFirst, addRow],
  );

  const stopFilling = useCallback(() => {
    setValues(null);
    setPlace(undefined);
  }, []);

  return {
    /** What the row being filled holds, while one is. */
    filling: values,
    place,
    addAndOpen,
    addInGrid,
    addBeside,
    addWith,
    stopFilling,
  };
}
