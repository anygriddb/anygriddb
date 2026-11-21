import { useState } from "react";

/** Rows per page offered on Administration lists. */
export const ADMIN_PAGE_SIZES = [20, 50, 100] as const;

export type AdminPageSize = (typeof ADMIN_PAGE_SIZES)[number];

export const DEFAULT_ADMIN_PAGE_SIZE: AdminPageSize = 50;

const STORAGE_KEY = "ag.admin.pageSize";

/** Accepts a stored value; anything else becomes the default. */
export function parseAdminPageSize(
  raw: string | null | undefined,
): AdminPageSize {
  const value = Number(raw);
  return (ADMIN_PAGE_SIZES as readonly number[]).includes(value)
    ? (value as AdminPageSize)
    : DEFAULT_ADMIN_PAGE_SIZE;
}

export function readAdminPageSize(): AdminPageSize {
  if (typeof localStorage === "undefined") return DEFAULT_ADMIN_PAGE_SIZE;
  return parseAdminPageSize(localStorage.getItem(STORAGE_KEY));
}

export function writeAdminPageSize(size: AdminPageSize): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, String(size));
}

/**
 * Shared page size for Administration tables. Stored in localStorage so the
 * next visit keeps the choice; changing it resets the caller's page to 1.
 */
export function useAdminPageSize(): [
  AdminPageSize,
  (size: AdminPageSize) => void,
] {
  const [size, setSize] = useState<AdminPageSize>(readAdminPageSize);
  return [
    size,
    (next) => {
      writeAdminPageSize(next);
      setSize(next);
    },
  ];
}

/** The last page that holds a row; the first when none does. */
export function lastAdminPage(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * 1-based page index for a list. A new page size or reset key starts again
 * at page 1 without an effect.
 */
export function useAdminPage(
  pageSize: number,
  resetKey?: string | number | boolean,
): {
  page: number;
  setPage: (page: number) => void;
  offset: number;
  limit: number;
} {
  const key = `${pageSize}:${String(resetKey ?? "")}`;
  const [pages, setPages] = useState<Record<string, number>>({});
  const page = pages[key] ?? 1;
  return {
    page,
    setPage: (next) => {
      setPages((current) => ({ ...current, [key]: next }));
    },
    offset: (page - 1) * pageSize,
    limit: pageSize,
  };
}
