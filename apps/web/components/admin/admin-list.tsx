import { Button, cn, Select } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import type { HTMLAttributes, ReactNode } from "react";
import { ADMIN_PAGE_SIZES, type AdminPageSize } from "./admin-page-size";

/**
 * Scroll shell for an Administration table: grows with a few rows, caps at
 * the viewport so long lists stay on the page, sticky header inside.
 */
export function AdminTable({
  children,
  className,
  tableClassName,
  ...region
}: {
  children: ReactNode;
  className?: string;
  tableClassName?: string;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...region}
      className={cn(
        "max-h-[calc(100dvh-14rem)] overflow-auto rounded-sm border border-border",
        className,
      )}
    >
      <table className={cn("w-full text-sm", tableClassName)}>{children}</table>
    </div>
  );
}

/** Sticky header row for {@link AdminTable}. */
export function AdminTableHead({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <thead
      className={cn(
        "sticky top-0 z-10 bg-muted text-left text-xs shadow-[0_1px_0_0_var(--border)]",
        className,
      )}
    >
      {children}
    </thead>
  );
}

/**
 * Range, previous/next, and page-size select for an Administration list.
 * Shown whenever there is at least one row (so the size can be changed
 * before the list grows).
 */
export function AdminPager({
  total,
  offset,
  pageSize,
  onPageSize,
  onPrev,
  onNext,
}: {
  total: number;
  offset: number;
  pageSize: AdminPageSize;
  onPageSize: (size: AdminPageSize) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useLingui();
  if (total <= 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + pageSize, total);
  const page = Math.floor(offset / pageSize) + 1;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t`${{ from }}–${{ to }} of ${{ total }}`}</span>
      {total > pageSize ? (
        <>
          <Button
            reads
            size="sm"
            variant="ghost"
            disabled={page <= 1}
            onClick={onPrev}
          >
            {t`Previous`}
          </Button>
          <Button
            reads
            size="sm"
            variant="ghost"
            disabled={offset + pageSize >= total}
            onClick={onNext}
          >
            {t`Next`}
          </Button>
        </>
      ) : null}
      <AdminPageSizeSelect size={pageSize} onChange={onPageSize} />
    </div>
  );
}

/** Page-size select alone, for lists that page by cursor instead of offset. */
export function AdminPageSizeSelect({
  size,
  onChange,
  className,
}: {
  size: AdminPageSize;
  onChange: (size: AdminPageSize) => void;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <label className={cn("ml-auto flex items-center gap-1.5", className)}>
      <span className="sr-only">{t`Rows per page`}</span>
      <Select
        reads
        aria-label={t`Rows per page`}
        className="h-7 w-auto text-xs"
        value={String(size)}
        onChange={(event) => {
          const next = Number(event.target.value);
          if ((ADMIN_PAGE_SIZES as readonly number[]).includes(next)) {
            onChange(next as AdminPageSize);
          }
        }}
      >
        {ADMIN_PAGE_SIZES.map((value) => (
          <option key={value} value={value}>
            {t`${{ value }} per page`}
          </option>
        ))}
      </Select>
    </label>
  );
}
