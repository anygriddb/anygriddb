/**
 * Moving a dashboard widget onto another. React Aria's hooks (ADR 0012)
 * drive it by mouse, touch, keyboard, and screen reader. The widget
 * travels as its id, under a type of its own so a row drag never lands
 * on a dashboard.
 */
import { isTextDropItem, useDrag, useDrop } from "@anygriddb/ui";
import { useEffect, useRef, type RefObject } from "react";

const WIDGET_TYPE = "application/x-anygriddb-widget";

/**
 * The widget being dragged in this tab, while it is. A drop refuses the
 * widget's own card from this, because the drag ends before the id is
 * read. Held in an object that is never replaced, as a row's drag is
 * (`lib/drag.ts`): the React Compiler reads a module's variable where it
 * is used.
 */
const drag: { widgetId: string | null } = { widgetId: null };

export function useWidgetDrag(id: string, label: string, enabled: boolean) {
  return useDrag({
    isDisabled: !enabled,
    // Picked up by its handle from the keyboard: the header's own buttons
    // keep their keys and their clicks.
    hasDragButton: true,
    getItems: () => [{ [WIDGET_TYPE]: id, "text/plain": label }],
    onDragStart: () => {
      drag.widgetId = id;
    },
    onDragEnd: () => {
      drag.widgetId = null;
    },
  });
}

/** Calls `onPlace` with the id of a widget dropped on `ref`. */
export function useWidgetDrop(
  ref: RefObject<HTMLElement | null>,
  widgetId: string,
  onPlace: (draggedId: string) => void,
  enabled: boolean,
) {
  const onPlaceRef = useRef(onPlace);
  useEffect(() => {
    onPlaceRef.current = onPlace;
  }, [onPlace]);
  return useDrop({
    ref,
    isDisabled: !enabled,
    getDropOperation: (types) =>
      types.has(WIDGET_TYPE) && drag.widgetId !== widgetId ? "move" : "cancel",
    onDrop: (event) => {
      for (const item of event.items) {
        if (!isTextDropItem(item) || !item.types.has(WIDGET_TYPE)) continue;
        void item.getText(WIDGET_TYPE).then((id) => {
          if (!id || id === widgetId) return;
          onPlaceRef.current(id);
        });
      }
    },
  });
}
