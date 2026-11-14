/**
 * What a write changed, read from the trail's snapshots of a row (or a
 * catalog item) before and after it: field names only, never values.
 */

/** Keys every write touches, which say nothing of what it changed. */
const IGNORED_KEYS = new Set(["ag_updated_at", "ag_updated_by", "ag_seq"]);

/** Field names a change touched, from the audit snapshots, sorted. */
export function changedKeys(oldValue: unknown, newValue: unknown): string[] {
  const before = (
    oldValue && typeof oldValue === "object" ? oldValue : {}
  ) as Record<string, unknown>;
  const after = (
    newValue && typeof newValue === "object" ? newValue : {}
  ) as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => key !== "id" && !IGNORED_KEYS.has(key))
    .filter(
      (key) =>
        JSON.stringify(before[key] ?? null) !==
        JSON.stringify(after[key] ?? null),
    )
    .sort();
}
