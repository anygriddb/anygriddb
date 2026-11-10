import { cn } from "@anygriddb/ui";
import type { ReactNode } from "react";

/**
 * A page of the notebook (`docs/brand.md`): the desk around a sheet-wide
 * column and a large title. Settings, administration, dashboards, and a
 * base's home share it.
 */
export function NotebookPage({
  title,
  description,
  action,
  children,
  className,
  width = "md",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  width?: "md" | "lg" | "xl";
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col px-8 py-10",
        width === "md" && "max-w-3xl",
        width === "lg" && "max-w-4xl",
        width === "xl" && "max-w-6xl",
        className,
      )}
    >
      <header className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-semibold">{title}</h1>
          {description ? (
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </header>
      <div className="mt-3 flex flex-col">{children}</div>
    </div>
  );
}

/**
 * A ruled section: label and description on the left, controls on the
 * right. Used on account, base, and admin settings.
 */
export function RuledSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "grid gap-x-10 gap-y-3 border-b border-rule py-7 md:grid-cols-[12rem_minmax(0,1fr)]",
        className,
      )}
    >
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 text-[13px] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}

/**
 * Empty end of a page: one short line and at most one primary action.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 border-b border-rule py-10",
        className,
      )}
    >
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}
