import { cn } from "@anygriddb/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A page of the notebook (`docs/brand.md`): the desk around one column
 * and a large title. Home, a base's home, settings, and dashboards share
 * the same column, so a title never moves from one page to the next;
 * `wide` is for the pages that hold a table of many columns
 * (administration, the API page).
 */
export function NotebookPage({
  title,
  description,
  action,
  children,
  className,
  width = "page",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  width?: "page" | "wide";
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col px-4 py-8 md:px-8 md:py-10",
        width === "page" && "max-w-4xl",
        width === "wide" && "max-w-6xl",
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

/** The views of a notebook page, as tabs underlined on the page's rule. */
export function PageTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: ReadonlyArray<{ value: T; label: string; icon?: LucideIcon }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="mt-4 flex gap-1 overflow-x-auto border-b border-rule"
    >
      {tabs.map(({ value: id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
            value === id
              ? "border-primary font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
          {label}
        </button>
      ))}
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
