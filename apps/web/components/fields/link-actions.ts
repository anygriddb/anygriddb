import { coerceCellValue } from "@anygriddb/core";
import {
  canWrite,
  type CatalogColumn,
  type CatalogTable,
} from "../../lib/types";
import type { CellValue } from "../table/table-context";

/** Field types whose typed text names a new row well. */
const NAMING_TYPES = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "number",
  "single_select",
]);

/** The table a link field points to, when the reader can open it. */
export function linkTarget(
  column: CatalogColumn,
  tables: readonly CatalogTable[],
): CatalogTable | undefined {
  const id = column.relation?.targetTableId;
  return id ? tables.find((table) => table.id === id) : undefined;
}

/**
 * The row a link picker creates from what was typed: the text goes into the
 * other table's primary field. Undefined when that table is a client's
 * (a new row there is checked as a whole), when the reader cannot add rows
 * to it, when its primary field cannot take the text, or when the field
 * offers only the rows of a view or a filter: a new row may fall outside
 * them, and the link would be refused.
 */
export function linkedRowDraft(
  column: CatalogColumn,
  tables: readonly CatalogTable[],
  text: string,
): { tableId: string; values: Record<string, CellValue> } | undefined {
  const typed = text.trim();
  const target = linkTarget(column, tables);
  const limited = column.config.selectFrom !== undefined;
  if (
    !typed ||
    limited ||
    !target ||
    target.external ||
    !canWrite(target.role)
  ) {
    return undefined;
  }
  const primary = target.columns.find((item) => item.isPrimary);
  if (
    !primary ||
    primary.access === "read" ||
    primary.error ||
    !NAMING_TYPES.has(primary.fieldType)
  ) {
    return undefined;
  }
  const value = coerceCellValue(
    { fieldType: primary.fieldType, config: primary.config },
    typed,
  );
  if (value === undefined || value === null) return undefined;
  return { tableId: target.id, values: { [primary.name]: value } };
}
