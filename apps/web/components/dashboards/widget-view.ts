import { aggregatesOfField, cellText, type FilterKind } from "@anygriddb/core";
import { cellDisplay } from "../../lib/format";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { canGroupBy } from "../table/field-roles";

const NO_PEOPLE: ReadonlyMap<string, Collaborator> = new Map();

/** What a field of these kinds holds is one value a figure can show. */
const ONE_VALUE = new Set<FilterKind>(["text", "number", "date", "datetime"]);
/** Fields that read as a text and hold something else: a document, a button. */
const NOT_A_VALUE = new Set(["json", "button"]);

/**
 * The view a widget that shows one will show: the view chosen, or the
 * table's first while none is. A list with no empty choice shows its
 * first entry before anything is picked, so that entry is what the
 * person reads as chosen: a table with one view left nothing to pick,
 * and the widget could not be added.
 */
export function embeddedViewId(
  views: ReadonlyArray<{ id: string }>,
  chosen: string,
): string {
  return views.find((view) => view.id === chosen)?.id ?? views[0]?.id ?? "";
}

/**
 * The field a list shows as chosen: the one chosen while the list holds
 * it, or the list's first, which a list with no empty choice shows
 * whatever its form holds. A form that kept what was chosen for another
 * table, or for another measure, saved a widget of a field its list did
 * not show, and its table did not have.
 */
export function fieldShown(
  fields: ReadonlyArray<{ name: string }>,
  chosen: string,
): string {
  return (
    fields.find((field) => field.name === chosen)?.name ?? fields[0]?.name ?? ""
  );
}

/**
 * The same for a list that may be left empty: none while the list does
 * not hold the field chosen.
 */
export function fieldKept(
  fields: ReadonlyArray<{ name: string }>,
  chosen: string,
): string {
  return fields.some((field) => field.name === chosen) ? chosen : "";
}

/**
 * The fields a chart's list offers to group by, by the rule the server
 * holds a group to. One saved before it was refused stays listed: the
 * person sees what the chart asks for, and can change it.
 */
export function groupChoices(
  columns: readonly CatalogColumn[],
  chosen: string,
): CatalogColumn[] {
  return columns.filter(
    (column) => canGroupBy(column) || column.name === chosen,
  );
}

/**
 * The fields a measure can read, by the rule the server holds a measure
 * to: for a sum, a mean, or an extreme, those that read as a number, a
 * formula's or a rollup's result among them; for the count of the rows
 * that hold a value, any field but a checkbox. A count of rows reads
 * none. The last value is read of a field that holds one value: a text,
 * a number, a date.
 */
export function measurableFields<
  Field extends { kind: FilterKind; fieldType: string; noCompare?: boolean },
>(fields: readonly Field[], fn: string): readonly Field[] {
  if (fn === "count_all") return [];
  if (fn === "last") {
    return fields.filter(
      (field) => ONE_VALUE.has(field.kind) && !NOT_A_VALUE.has(field.fieldType),
    );
  }
  return fields.filter((field) =>
    aggregatesOfField(field).some((allowed) => allowed === fn),
  );
}

/**
 * The fields that can put rows in order for a figure's last value: a
 * date or an instant first, as a balance is read on its latest day, then
 * a number.
 */
export function orderingFields<Field extends { kind: FilterKind }>(
  fields: readonly Field[],
): Field[] {
  const dated = fields.filter(
    (field) => field.kind === "date" || field.kind === "datetime",
  );
  return [...dated, ...fields.filter((field) => field.kind === "number")];
}

/**
 * The measure a widget's list shows: a chart has no last value, so a
 * figure turned into a chart counts rows, as its list then shows.
 */
export function measureShown(kind: string, fn: string): string {
  return kind === "chart" && fn === "last" ? "count_all" : fn;
}

/**
 * A figure's last value, written as its field writes a cell: a number in
 * the field's format, a date as a date, a text as it is. A dash while
 * there is none.
 */
export function lastValueText(
  value: unknown,
  column: CatalogColumn | undefined,
  locale: "fr" | "en",
): string {
  if (value === null || value === undefined || value === "") return "—";
  return column
    ? cellDisplay(value, column, locale, NO_PEOPLE)
    : cellText(value);
}

/** Rows a view's widget shows: a glance, the view itself is a click away. */
export const WIDGET_ROWS = 20;

/**
 * How many rows of its view a widget leaves out, for the line under them
 * that says so. None when the view's rows were not counted.
 */
export function rowsLeftOut(
  shown: number,
  total: number | null | undefined,
): number {
  return total === null || total === undefined ? 0 : Math.max(0, total - shown);
}

/**
 * The field a figure or a chart measures, as the catalog holds it: its
 * format is the one its sum or its mean is written in. None when the
 * widget counts rows, or when the field is gone or hidden from the reader.
 */
export function measuredColumn<Column extends { name: string }>(
  tables: ReadonlyArray<{ id: string; columns: readonly Column[] }> | undefined,
  config: Record<string, unknown>,
): Column | undefined {
  return tables
    ?.find((table) => table.id === config.tableId)
    ?.columns.find((column) => column.name === config.column);
}

/** Measures that add up: their series can stand one on another. */
const ADDITIVE = new Set([
  "count_all",
  "count_empty",
  "count_filled",
  "sum",
  "checked",
  "unchecked",
]);

/** Whether the series of a measure add up to something: a sum, a count. */
export function measureAddsUp(fn: string): boolean {
  return ADDITIVE.has(fn);
}

/**
 * How many categories a chart is asked to draw, from what was typed:
 * a whole number from 1 to `most`. Nothing typed, or no number, asks
 * for none in particular.
 */
export function categoriesAsked(typed: string, most: number): number | null {
  const asked = Number(typed.trim());
  if (typed.trim() === "" || !Number.isFinite(asked)) return null;
  return Math.min(most, Math.max(1, Math.trunc(asked)));
}
