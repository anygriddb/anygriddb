import {
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type ResizeBounds = {
  min: number;
  max: number;
  /** The width a double click (and the keyboard's Enter) comes back to. */
  reset?: number;
  /** One arrow press; Shift moves four. */
  step?: number;
};

/** Where a resize stands: being dragged, or done (a cancelled drag ends at its start). */
export type ResizePhase = "move" | "end";

export function clampWidth(width: number, bounds: ResizeBounds): number {
  return Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
}

/** The width a key gives a separator, or null for a key it leaves alone. */
export function widthForKey(
  width: number,
  key: string,
  bounds: ResizeBounds,
  coarse = false,
): number | null {
  const step = (bounds.step ?? 16) * (coarse ? 4 : 1);
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width - step, bounds);
    case "ArrowRight":
      return clampWidth(width + step, bounds);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    case "Enter":
      return bounds.reset ?? null;
    default:
      return null;
  }
}

/**
 * A vertical separator that resizes what is on its left: dragged with the
 * pointer, which it holds until released (so a release outside the
 * window still ends it, and a cancelled gesture puts the width back), or
 * moved by the arrows, Home, and End when `keyboard` is on (WCAG 2.1.1,
 * 2.5.7). `onResize` hears each step with "move" and the last with "end".
 */
export function useResizeHandle(props: {
  width: number;
  bounds: ResizeBounds;
  label: string;
  keyboard?: boolean;
  onResize: (width: number, phase: ResizePhase) => void;
}) {
  const { width, bounds, label, keyboard = false, onResize } = props;
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const at = (event: ReactPointerEvent) => {
    const current = drag.current;
    return current
      ? clampWidth(current.startWidth + event.clientX - current.startX, bounds)
      : width;
  };
  return {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": label,
    ...(keyboard
      ? {
          tabIndex: 0,
          "aria-valuenow": width,
          "aria-valuemin": bounds.min,
          "aria-valuemax": bounds.max,
        }
      : {}),
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: width,
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      onResize(at(event), "move");
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const next = at(event);
      drag.current = null;
      onResize(next, "end");
    },
    // Released without an up (a cancelled touch, a lost window): undone.
    onLostPointerCapture: () => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      onResize(current.startWidth, "end");
    },
    onDoubleClick: () => {
      if (bounds.reset !== undefined) onResize(bounds.reset, "end");
    },
    ...(keyboard
      ? {
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            const next = widthForKey(width, event.key, bounds, event.shiftKey);
            if (next === null) return;
            event.preventDefault();
            event.stopPropagation();
            onResize(next, "end");
          },
        }
      : {}),
  };
}
