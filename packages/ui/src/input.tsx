import type { ComponentProps } from "react";
import { cn } from "./cn";
import { useReadOnly, type Reads } from "./read-only";

const field =
  "w-full rounded-md border border-border bg-card px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:opacity-60";

export function Input({
  className,
  reads,
  disabled,
  ...props
}: ComponentProps<"input"> & Reads) {
  const off = useReadOnly(reads);
  return (
    <input
      className={cn(field, "h-9", className)}
      {...props}
      disabled={disabled || off}
    />
  );
}

export function Textarea({
  className,
  reads,
  disabled,
  ...props
}: ComponentProps<"textarea"> & Reads) {
  const off = useReadOnly(reads);
  return (
    <textarea
      className={cn(field, "min-h-20 py-2", className)}
      {...props}
      disabled={disabled || off}
    />
  );
}

export function Select({
  className,
  reads,
  disabled,
  ...props
}: ComponentProps<"select"> & Reads) {
  const off = useReadOnly(reads);
  return (
    <select
      className={cn(field, "h-9 pr-8", className)}
      {...props}
      disabled={disabled || off}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn("text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function Checkbox({
  className,
  reads,
  disabled,
  ...props
}: ComponentProps<"input"> & Reads) {
  const off = useReadOnly(reads);
  return (
    <input
      type="checkbox"
      className={cn(
        "h-4 w-4 cursor-pointer rounded accent-[var(--ag-primary)] disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
      disabled={disabled || off}
    />
  );
}
