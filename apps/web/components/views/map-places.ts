import type { FilterGroup } from "@anygriddb/core";
import type { CatalogColumn } from "../../lib/types";

/** A map shows the places of this many rows at most, and says so past it. */
export const MAP_CEILING = 5_000;

/** What a map reads its places from. */
export type MapPlaces = {
  /** The table's place fields, and its number fields. */
  places: CatalogColumn[];
  numbers: CatalogColumn[];
  /** The place field read, when one is. */
  place: string | undefined;
  /** Otherwise two numbers: chosen, or found by name. */
  latitude: string | undefined;
  longitude: string | undefined;
};

/**
 * The fields a map reads its places from. A place field first: the one
 * the view chose, or the table's first as long as the view chose no
 * numbers. Otherwise two number fields, chosen or found by name.
 */
export function placeColumns(
  config: Record<string, unknown>,
  columns: readonly CatalogColumn[],
): MapPlaces {
  const places = columns.filter((column) => column.fieldType === "place");
  const numbers = columns.filter((column) => column.kind === "number");
  const chosen = (key: string) =>
    typeof config[key] === "string" ? config[key] : undefined;
  const place =
    places.find((column) => column.name === chosen("placeColumn"))?.name ??
    (chosen("latitudeColumn") || chosen("longitudeColumn")
      ? undefined
      : places[0]?.name);
  if (place) {
    return {
      places,
      numbers,
      place,
      latitude: undefined,
      longitude: undefined,
    };
  }
  return {
    places,
    numbers,
    place: undefined,
    latitude:
      chosen("latitudeColumn") ??
      numbers.find((column) => /lat/i.test(column.name))?.name,
    longitude:
      chosen("longitudeColumn") ??
      numbers.find((column) => /lon|lng/i.test(column.name))?.name,
  };
}

/**
 * What a map says instead of an empty sheet, as the kanban and the
 * calendar do: no notice once it knows where its places are; otherwise,
 * to add a place field where the table has nothing to read, or to choose.
 */
export function mapNotice(
  found: Pick<
    MapPlaces,
    "places" | "numbers" | "place" | "latitude" | "longitude"
  >,
): "add-fields" | "choose-fields" | null {
  if (found.place || (found.latitude && found.longitude)) return null;
  return found.places.length === 0 && found.numbers.length < 2
    ? "add-fields"
    : "choose-fields";
}

/**
 * The rows that have a place: the place field filled, or both coordinates
 * set and on the globe. A map reads only those, so a table of many rows
 * without a place does not hide the ones that have one.
 */
export function placeFilter(
  found: Pick<MapPlaces, "place" | "latitude" | "longitude">,
): FilterGroup | undefined {
  if (found.place) {
    return {
      conjunction: "and",
      conditions: [{ column: found.place, op: "is_not_empty" }],
    };
  }
  if (!found.latitude || !found.longitude) return undefined;
  return {
    conjunction: "and",
    conditions: [
      { column: found.latitude, op: "is_between", value: ["-90", "90"] },
      { column: found.longitude, op: "is_between", value: ["-180", "180"] },
    ],
  };
}
