import type { FilterGroup } from "@anygriddb/core";
import type { CatalogColumn } from "../../lib/types";

/** A map shows the places of this many rows at most, and says so past it. */
export const MAP_CEILING = 5_000;

/** The fields a map reads its places from: chosen, or found by name. */
export function placeColumns(
  config: Record<string, unknown>,
  columns: readonly CatalogColumn[],
): {
  numbers: CatalogColumn[];
  latitude: string | undefined;
  longitude: string | undefined;
} {
  const numbers = columns.filter((column) => column.kind === "number");
  return {
    numbers,
    latitude:
      typeof config.latitudeColumn === "string"
        ? config.latitudeColumn
        : numbers.find((column) => /lat/i.test(column.name))?.name,
    longitude:
      typeof config.longitudeColumn === "string"
        ? config.longitudeColumn
        : numbers.find((column) => /lon|lng/i.test(column.name))?.name,
  };
}

/**
 * The rows that have a place: both coordinates set and on the globe. A
 * map reads only those, so a table of many rows without a place does not
 * hide the ones that have one.
 */
export function placeFilter(latitude: string, longitude: string): FilterGroup {
  return {
    conjunction: "and",
    conditions: [
      { column: latitude, op: "is_between", value: ["-90", "90"] },
      { column: longitude, op: "is_between", value: ["-180", "180"] },
    ],
  };
}
