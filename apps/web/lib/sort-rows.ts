export type SortDir = "asc" | "desc";

export type SortValue = string | number | boolean | null | undefined;

export type ColumnSort<Key extends string> = {
  key: Key;
  dir: SortDir;
};

function empty(value: SortValue): boolean {
  return value === null || value === undefined || value === "";
}

function byTie(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Orders rows already on the page. Empty values stay last either way.
 * Equal values keep a stable order by `tie`.
 */
export function sortRows<T, Key extends string>(
  rows: readonly T[],
  sort: ColumnSort<Key> | null,
  value: (row: T, key: Key) => SortValue,
  tie: (row: T) => string,
): T[] {
  if (!sort) return [...rows];
  const dir = sort.dir === "desc" ? -1 : 1;
  return rows.slice().sort((left, right) => {
    const a = value(left, sort.key);
    const b = value(right, sort.key);
    if (empty(a) || empty(b)) {
      if (empty(a) && empty(b)) return byTie(tie(left), tie(right));
      return empty(a) ? 1 : -1;
    }
    const compared =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : typeof a === "boolean" && typeof b === "boolean"
          ? Number(a) - Number(b)
          : String(a).localeCompare(String(b), undefined, {
              numeric: true,
              sensitivity: "base",
            });
    if (compared === 0) return byTie(tie(left), tie(right));
    return compared * dir;
  });
}
