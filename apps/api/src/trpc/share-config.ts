import {
  isFilterGroup,
  type FilterGroup,
  type ViewConfig,
} from "@anygriddb/core";

/** Display settings a link needs: filter values and internals stay private. */
const DISPLAY_KEYS = [
  "fieldOrder",
  "columnWidths",
  "rowHeight",
  "stackColumn",
  "coverColumn",
  "coverFit",
  "titleColumn",
  "cardFields",
  "startColumn",
  "endColumn",
  "timelineScale",
  "form",
] as const;

const ONE_FIELD_KEYS = [
  "stackColumn",
  "coverColumn",
  "titleColumn",
  "startColumn",
  "endColumn",
] as const;

type Form = NonNullable<ViewConfig["form"]>;

/**
 * A form as a link gives it. A field it does not show keeps its place, as
 * a condition counts only on fields placed before it, under a name that
 * says nothing: the browser reaches the answer the server will.
 */
function publicForm(form: Form, shown: ReadonlySet<string>): Form {
  if (!form.fields) return form;
  const masks = new Map<string, string>();
  const nameOf = (column: string): string => {
    if (shown.has(column)) return column;
    const mask = masks.get(column) ?? `hidden_${String(masks.size + 1)}`;
    masks.set(column, mask);
    return mask;
  };
  const masked = (group: FilterGroup): FilterGroup => ({
    ...group,
    conditions: group.conditions.map((node) =>
      isFilterGroup(node)
        ? masked(node)
        : { ...node, column: nameOf(node.column) },
    ),
  });
  return {
    ...form,
    fields: form.fields.map((field) =>
      shown.has(field.column)
        ? {
            ...field,
            ...(field.showIf ? { showIf: masked(field.showIf) } : {}),
          }
        : { column: nameOf(field.column), hidden: true },
    ),
  };
}

/**
 * A view's settings as a link gives them to anyone who opens it: they name
 * the fields it shows, and no other, since a field's name can say what its
 * values are.
 */
export function publicConfig(
  config: ViewConfig,
  fields: readonly string[],
): Partial<ViewConfig> {
  const shown = new Set(fields);
  const display: Partial<ViewConfig> = Object.fromEntries(
    DISPLAY_KEYS.flatMap((key) =>
      config[key] === undefined ? [] : [[key, config[key]]],
    ),
  );
  for (const key of ONE_FIELD_KEYS) {
    const name = display[key];
    if (name !== undefined && !shown.has(name)) {
      Reflect.deleteProperty(display, key);
    }
  }
  if (display.fieldOrder) {
    display.fieldOrder = display.fieldOrder.filter((name) => shown.has(name));
  }
  if (display.cardFields) {
    display.cardFields = display.cardFields.filter((name) => shown.has(name));
  }
  if (display.columnWidths) {
    display.columnWidths = Object.fromEntries(
      Object.entries(display.columnWidths).filter(([name]) => shown.has(name)),
    );
  }
  if (display.form) display.form = publicForm(display.form, shown);
  return display;
}
