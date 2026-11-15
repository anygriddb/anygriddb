import { cn } from "@anygriddb/ui";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ColumnSort, SortDir } from "../lib/sort-rows";

/**
 * A column heading that sorts. The button is a plain one, so a page that
 * only reads (an auditor) can still use it.
 */
export function SortHeader({
  label,
  active,
  descending,
  onSort,
  className,
  align = "left",
}: {
  label: ReactNode;
  active: boolean;
  descending: boolean;
  onSort: () => void;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn("px-2 py-1.5", className)}
      aria-sort={active ? (descending ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 hover:underline",
          align === "right" && "w-full justify-end",
        )}
        onClick={onSort}
      >
        {label}
        {active ? (
          descending ? (
            <ArrowDown className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowUp className="h-3 w-3" aria-hidden />
          )
        ) : null}
      </button>
    </th>
  );
}

/** The column a table is sorted by, remembered while the page is open. */
export function useColumnSort<Key extends string>() {
  const [sort, setSort] = useState<ColumnSort<Key> | null>(null);
  const toggle = (key: Key) => {
    setSort((current) => {
      if (current?.key !== key) return { key, dir: "asc" };
      const dir: SortDir = current.dir === "asc" ? "desc" : "asc";
      return { key, dir };
    });
  };
  const header = (
    key: Key,
    label: ReactNode,
    className?: string,
    align?: "left" | "right",
  ) => (
    <SortHeader
      label={label}
      active={sort?.key === key}
      descending={sort?.key === key && sort.dir === "desc"}
      onSort={() => toggle(key)}
      className={className}
      align={align}
    />
  );
  return { sort, header, toggle };
}
