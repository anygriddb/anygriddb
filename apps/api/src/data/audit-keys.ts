/**
 * What a write changed, read from the trail's snapshots of a row (or a
 * catalog item) before and after it: field names only, never values.
 */
import { compareCodeUnits } from "@anygriddb/core";

/**
 * Keys every write touches, which say nothing of what it changed: who
 * wrote and when is the event's own, the row's creation included.
 */
const IGNORED_KEYS = new Set([
  "ag_updated_at",
  "ag_updated_by",
  "ag_seq",
  "ag_created_at",
  "ag_created_by",
]);

/**
 * What a row is given when it is made and loses when it goes: its status
 * and its place are a change only between two states of the row.
 */
const GIVEN_WITH_THE_ROW = new Set(["ag_status", "ag_position"]);

const isRecord = (value: unknown): boolean =>
  Boolean(value) && typeof value === "object";

/** Field names a change touched, from the audit snapshots, sorted. */
export function changedKeys(oldValue: unknown, newValue: unknown): string[] {
  const before = (
    oldValue && typeof oldValue === "object" ? oldValue : {}
  ) as Record<string, unknown>;
  const after = (
    newValue && typeof newValue === "object" ? newValue : {}
  ) as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  // Made or deleted: one side holds nothing of the row.
  const whole = !isRecord(oldValue) || !isRecord(newValue);
  return [...keys]
    .filter((key) => key !== "id" && !IGNORED_KEYS.has(key))
    .filter((key) => !(whole && GIVEN_WITH_THE_ROW.has(key)))
    .filter(
      (key) =>
        JSON.stringify(before[key] ?? null) !==
        JSON.stringify(after[key] ?? null),
    )
    .sort(compareCodeUnits);
}
