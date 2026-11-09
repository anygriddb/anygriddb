import { cn } from "@anygriddb/ui";

/**
 * AnyGridDB's mark: a rounded square of the primary colour with a grid of
 * four cells (`docs/brand.md`). The cells take the colour written on the
 * primary, so the mark keeps its contrast in both themes.
 */
export function BrandMark({
  className,
  title,
}: {
  className?: string;
  /** Names the mark for assistive technology; without it, decorative. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 text-primary", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <rect width="32" height="32" rx="8" fill="currentColor" />
      {[
        [7, 7],
        [17.5, 7],
        [7, 17.5],
        [17.5, 17.5],
      ].map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width="7.5"
          height="7.5"
          rx="1.5"
          fill="var(--color-primary-foreground)"
        />
      ))}
    </svg>
  );
}
