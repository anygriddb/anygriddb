import { createContext, useContext } from "react";
import type {
  CatalogColumn,
  CatalogTable,
  Collaborator,
  Grant,
  RowItem,
  ViewItem,
} from "../../lib/types";

export type CellValue = string | number | boolean | null | string[];

export type TableContextValue = {
  baseId: string;
  table: CatalogTable;
  tables: readonly CatalogTable[];
  columns: readonly CatalogColumn[];
  role: Grant | null;
  view: ViewItem | null;
  people: ReadonlyMap<string, Collaborator>;
  locale: "fr" | "en";
  search: string;
  /**
   * Writes cell values. Resolves once the server accepted them. `seen` is
   * what an editor showed when it opened: the write is refused if the
   * field holds something else by then (ADR 0103).
   */
  updateCells: (
    updates: Array<{
      rowId: string;
      values: Record<string, CellValue>;
      seen?: Record<string, CellValue>;
    }>,
  ) => Promise<void>;
  /** Sets a link cell's rows. Resolves once the server took them. */
  setLinks: (
    rowId: string,
    column: string,
    targetIds: string[],
  ) => Promise<void>;
  openRecord: (rowId: string) => void;
  rowsById: ReadonlyMap<string, RowItem>;
  /** Whether a write is in flight, for the active cell hint. */
  saveStatus: "idle" | "saving" | "saved" | "error";
  /**
   * The table's states in its circuit's order, each by its word for this
   * reader (ADR 0133): what a field of the row's state shows and chooses.
   */
  states: readonly { key: string; label: string }[];
};

export const TableContext = createContext<TableContextValue | null>(null);

export function useTable(): TableContextValue {
  const value = useContext(TableContext);
  if (!value) {
    throw new Error("Table context missing");
  }
  return value;
}
