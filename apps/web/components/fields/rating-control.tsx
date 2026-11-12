import { cn } from "@anygriddb/ui";
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { RATING_ICON, ratingVisual } from "./field-appearance";
import type { CatalogColumn } from "../../lib/types";

/**
 * Rating glyphs for a column: read-only display, or an interactive slider
 * (click + arrows + digits) that matches the field's icon and colour.
 */
export function RatingControl({
  column,
  value,
  interactive = false,
  onChange,
  onCommit,
  onCancel,
  autoFocus = false,
  id,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-required": ariaRequired,
}: {
  column: CatalogColumn;
  value: number | null;
  interactive?: boolean;
  onChange?: (value: number | null) => void;
  onCommit?: (value: number | null) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
}): ReactElement {
  const { max, icon, color } = ratingVisual(column);
  const Icon = RATING_ICON[icon];
  const current = value ?? 0;
  const box = useRef<HTMLDivElement>(null);
  const draft = useRef(value);

  useEffect(() => {
    draft.current = value;
  }, [value]);

  useEffect(() => {
    if (autoFocus && interactive) box.current?.focus();
  }, [autoFocus, interactive]);

  function set(next: number | null) {
    draft.current = next;
    onChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
      return;
    }
    if (key === "Enter" || key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onCommit?.(draft.current);
      return;
    }
    if (key === "ArrowRight" || key === "ArrowUp") {
      event.preventDefault();
      set(Math.min(max, current + 1));
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowDown") {
      event.preventDefault();
      set(Math.max(0, current - 1));
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      set(0);
      return;
    }
    if (key === "End") {
      event.preventDefault();
      set(max);
      return;
    }
    if (/^[0-9]$/.test(key)) {
      event.preventDefault();
      const digit = Number(key);
      set(digit === 0 ? null : Math.min(max, digit));
    }
  }

  const className = cn(
    "inline-flex bg-transparent",
    interactive
      ? "gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      : "",
    color ? `opt-${color}` : "text-warning",
  );

  if (!interactive) {
    return (
      <span role="img" className={className} aria-label={`${current}/${max}`}>
        {Array.from({ length: max }, (_, index) => (
          <Icon
            key={index}
            className={cn(
              "h-3.5 w-3.5",
              index < current ? "fill-current" : "opacity-25",
            )}
            aria-hidden
          />
        ))}
      </span>
    );
  }

  return (
    <div
      ref={box}
      id={id}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabelledBy ? undefined : column.label}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-required={ariaRequired || undefined}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={current}
      aria-valuetext={`${current}/${max}`}
      className={className}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      // A slider's parts are not controls of their own (ARIA): the glyphs
      // are drawn, and a click on one sets the rating it shows.
      onClick={(event) => {
        const glyph =
          event.target instanceof Element
            ? event.target.closest("[data-rating]")
            : null;
        const at = Number(glyph?.getAttribute("data-rating"));
        if (!Number.isInteger(at) || at < 1) return;
        const next = current === at ? null : at;
        set(next);
        onCommit?.(next);
      }}
    >
      {Array.from({ length: max }, (_, index) => {
        const at = index + 1;
        return (
          <span
            key={at}
            data-rating={at}
            aria-hidden
            className="cursor-pointer rounded-sm p-0.5 hover:opacity-90"
          >
            <Icon
              className={cn(
                "h-4 w-4",
                at <= current ? "fill-current" : "opacity-25",
              )}
            />
          </span>
        );
      })}
    </div>
  );
}
