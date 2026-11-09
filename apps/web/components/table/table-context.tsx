import { createContext, useContext } from "react";
import type {
  CatalogColumn,
  CatalogTable,
  Collaborator,
  Role,
  RowItem,
  ViewItem,
} from "../../lib/types";

export type CellValue = string | number | boolean | null | string[];

export type TableContextValue = {
  baseId: string;
  table: CatalogTable;
  tables: readonly CatalogTable[];
  columns: readonly CatalogColumn[];
  role: Role | null;
  view: ViewItem | null;
  people: ReadonlyMap<string, Collaborator>;
  locale: "fr" | "en";
  search: string;
  /** Writes cell values. Resolves once the server accepted them. */
  updateCells: (
    updates: Array<{ rowId: string; values: Record<string, CellValue> }>,
    options?: { undoable?: boolean },
  ) => Promise<void>;
  setLinks: (
    rowId: string,
    column: string,
    targetIds: string[],
  ) => Promise<void>;
  openRecord: (rowId: string) => void;
  rowsById: ReadonlyMap<string, RowItem>;
};

export const TableContext = createContext<TableContextValue | null>(null);

export function useTable(): TableContextValue {
  const value = useContext(TableContext);
  if (!value) {
    throw new Error("Table context missing");
  }
  return value;
}
