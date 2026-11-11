import { cn } from "@anygriddb/ui";

/** Placeholder rows/columns while the first page of the grid loads. */
export function GridSkeleton({
  rows = 12,
  columns = 6,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex border-b border-border bg-muted/40">
        <div className="h-9 w-10 shrink-0 border-r border-border" />
        {Array.from({ length: columns }, (_, index) => (
          <div
            key={index}
            className="flex h-9 w-36 items-center border-r border-border px-2"
          >
            <span className="h-3 w-20 animate-pulse rounded-sm bg-muted" />
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={row}
            className={cn(
              "flex border-b border-border",
              row % 2 === 1 && "bg-muted/20",
            )}
          >
            <div className="flex h-8 w-10 shrink-0 items-center justify-center border-r border-border">
              <span className="h-2.5 w-4 animate-pulse rounded-sm bg-muted" />
            </div>
            {Array.from({ length: columns }, (_, column) => (
              <div
                key={column}
                className="flex h-8 w-36 items-center border-r border-border px-2"
              >
                <span
                  className="h-2.5 animate-pulse rounded-sm bg-muted"
                  style={{ width: `${40 + ((row + column) % 5) * 10}%` }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
