import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTRPC } from "../../lib/trpc";
import type { RowItem } from "../../lib/types";

/** A row id no table has: a disabled query still needs valid input. */
const NO_ROW = "00000000-0000-4000-8000-000000000000";

/**
 * The row open in the side panel, and the rows before and after it in
 * the view's order. A row the view has not read (one opened by its link)
 * is read by itself.
 */
export function useRecordPanel(input: {
  tableId: string;
  /** A row to open on arrival. */
  initial: string | undefined;
  rowsById: ReadonlyMap<string, RowItem>;
  /** The rows read so far, in the view's order. */
  loaded: readonly RowItem[];
}) {
  const { tableId, rowsById, loaded } = input;
  const api = useTRPC();
  const [recordId, setRecordId] = useState<string | null>(
    input.initial ?? null,
  );
  const open = useCallback((rowId: string) => setRecordId(rowId), []);
  const close = useCallback(() => setRecordId(null), []);
  const alone = useQuery({
    ...api.rows.get.queryOptions({
      tableId,
      rowIds: recordId ? [recordId] : [NO_ROW],
    }),
    enabled: Boolean(recordId) && !rowsById.has(recordId ?? ""),
  });
  const row = recordId
    ? (rowsById.get(recordId) ?? alone.data?.rows[0])
    : undefined;
  const index = row ? loaded.findIndex((item) => item.id === row.id) : -1;
  const before = index > 0 ? loaded[index - 1]?.id : undefined;
  const after =
    index >= 0 && index < loaded.length - 1 ? loaded[index + 1]?.id : undefined;
  return {
    row,
    open,
    close,
    previous: before ? () => setRecordId(before) : undefined,
    next: after ? () => setRecordId(after) : undefined,
  };
}
