/**
 * What locking a client's row seals (ADR 0033). It seals every field the
 * row stores: the client's columns, a link as the key it holds, and
 * AnyGridDB's own fields. Formulas, lookups, and rollups follow other
 * rows and stay out. The canonical form puts names in order and writes
 * numbers canonical, and its SHA-256 is the row's fingerprint.
 */
import { numberToDecimal, toDecimalString } from "../decimal";
import type { EngineColumn, EngineTable } from "./engine";

const NUMERIC = new Set(["number", "rating", "duration"]);

/** The fields of `table` a lock seals. */
export function sealedFields(table: EngineTable): EngineColumn[] {
  return table.columns.filter(
    (column) =>
      column.physical !== undefined &&
      (!column.relation || column.relation.direction === "forward"),
  );
}

/** A link's cell as the key it holds: one id, a list of them, or null. */
function linkKeys(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const ids = value.map((item: unknown) =>
    item && typeof item === "object" && "id" in item ? String(item.id) : item,
  );
  if (ids.length === 0) return null;
  return ids.length === 1 ? ids[0] : ids;
}

/** One cell as a seal keeps it. */
export function sealValue(
  column: Pick<EngineColumn, "fieldType" | "relation">,
  value: unknown,
): unknown {
  if (value === undefined || value === null) return null;
  if (column.relation) return linkKeys(value);
  if (NUMERIC.has(column.fieldType)) {
    const text =
      typeof value === "number"
        ? numberToDecimal(value)
        : typeof value === "string"
          ? toDecimalString(value)
          : undefined;
    return text ?? value;
  }
  return value;
}

/** The sealed values of a row as the read engine returned it, by field name. */
export function sealRow(
  table: EngineTable,
  row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sealed: Record<string, unknown> = {};
  for (const column of sealedFields(table)) {
    sealed[column.name] = sealValue(column, row[column.name]);
  }
  return sealed;
}

/** The text a fingerprint hashes: `[name, value]` pairs in name order. */
export function sealText(values: Readonly<Record<string, unknown>>): string {
  const names = Object.keys(values).sort();
  return JSON.stringify(names.map((name) => [name, values[name] ?? null]));
}

/**
 * The sealed fields whose value moved: compared on the fields both sides
 * know, as a field removed from AnyGridDB after the lock is not the row's.
 */
export function sealDrift(
  sealed: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(sealed)
    .filter((name) => Object.hasOwn(current, name))
    .filter(
      (name) =>
        JSON.stringify(sealed[name] ?? null) !==
        JSON.stringify(current[name] ?? null),
    )
    .sort();
}
