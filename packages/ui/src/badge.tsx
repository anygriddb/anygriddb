import { useUiText } from "./text";
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

const COLORS = new Set([
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "brown",
]);

/** Pill for a select option. Unknown colours fall back to gray. */
export function OptionBadge({
  color,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { color?: string }) {
  const tone = color && COLORS.has(color) ? color : "gray";
  return (
    <span
      className={cn(
        `opt-${tone} inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-xs leading-4 font-medium`,
        className,
      )}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  const text = useUiText();
  return (
    <span
      role="status"
      aria-label={text.loading}
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary",
        className,
      )}
    />
  );
}

export function Avatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const tones = [
    "teal",
    "blue",
    "purple",
    "pink",
    "orange",
    "green",
    "red",
    "brown",
  ];
  return (
    <span
      title={name}
      className={cn(
        `opt-${tones[hash % tones.length]} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold`,
        className,
      )}
    >
      {initials || "?"}
    </span>
  );
}
