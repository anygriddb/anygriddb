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
