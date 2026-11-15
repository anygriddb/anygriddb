import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../../lib/types";
import { mapNotice, placeColumns, placeFilter } from "./map-places";

const column = (name: string, kind: string, fieldType = kind) =>
  ({ name, kind, fieldType }) as unknown as CatalogColumn;

const numbers = [
  column("latitude", "number"),
  column("lng", "number"),
  column("altitude", "number"),
];
const where = column("where", "text", "place");
const depot = column("depot", "text", "place");

describe("placeColumns", () => {
  const columns = [column("name", "text"), ...numbers];

  it("finds the coordinates by name among the numbers", () => {
    const found = placeColumns({}, columns);
    expect(found.place).toBeUndefined();
    expect(found.latitude).toBe("latitude");
    expect(found.longitude).toBe("lng");
    expect(found.numbers.map((item) => item.name)).toEqual([
      "latitude",
      "lng",
      "altitude",
    ]);
  });

  it("keeps the fields the view chose", () => {
    const found = placeColumns(
      { latitudeColumn: "altitude", longitudeColumn: "latitude" },
      columns,
    );
    expect(found).toMatchObject({
      latitude: "altitude",
      longitude: "latitude",
    });
  });

  it("finds nothing in a table without numbers or places", () => {
    expect(placeColumns({}, [column("lat", "text")])).toMatchObject({
      place: undefined,
      latitude: undefined,
      longitude: undefined,
    });
  });

  it("reads a place field before two numbers", () => {
    const found = placeColumns({}, [...columns, where, depot]);
    expect(found).toMatchObject({
      place: "where",
      latitude: undefined,
      longitude: undefined,
    });
    expect(found.places.map((item) => item.name)).toEqual(["where", "depot"]);
    // The one the view chose.
    expect(
      placeColumns({ placeColumn: "depot" }, [...columns, where, depot]).place,
    ).toBe("depot");
  });

  it("reads the numbers the view chose, though the table has a place field", () => {
    expect(
      placeColumns({ latitudeColumn: "latitude", longitudeColumn: "lng" }, [
        ...columns,
        where,
      ]),
    ).toMatchObject({
      place: undefined,
      latitude: "latitude",
      longitude: "lng",
    });
  });

  it("forgets a chosen place field that is one no longer", () => {
    // Deleted, or changed to a text: the first place field, or the numbers.
    expect(
      placeColumns({ placeColumn: "where" }, [...columns, depot]).place,
    ).toBe("depot");
    expect(placeColumns({ placeColumn: "where" }, columns)).toMatchObject({
      place: undefined,
      latitude: "latitude",
      longitude: "lng",
    });
  });
});

describe("placeFilter", () => {
  it("keeps the rows whose two coordinates are on the globe", () => {
    expect(
      placeFilter({ place: undefined, latitude: "lat", longitude: "lon" }),
    ).toEqual({
      conjunction: "and",
      conditions: [
        { column: "lat", op: "is_between", value: ["-90", "90"] },
        { column: "lon", op: "is_between", value: ["-180", "180"] },
      ],
    });
  });

  it("keeps the rows whose place field is filled", () => {
    expect(
      placeFilter({
        place: "where",
        latitude: undefined,
        longitude: undefined,
      }),
    ).toEqual({
      conjunction: "and",
      conditions: [{ column: "where", op: "is_not_empty" }],
    });
  });

  it("filters nothing while the map does not know where to read", () => {
    expect(
      placeFilter({ place: undefined, latitude: "lat", longitude: undefined }),
    ).toBeUndefined();
  });
});

describe("mapNotice", () => {
  const two = numbers.slice(0, 2);
  const none = { places: [], place: undefined };

  it("says nothing once it knows where its places are", () => {
    expect(
      mapNotice({ ...none, numbers: two, latitude: "x", longitude: "y" }),
    ).toBeNull();
    expect(
      mapNotice({
        places: [where],
        numbers: [],
        place: "where",
        latitude: undefined,
        longitude: undefined,
      }),
    ).toBeNull();
  });

  it("asks for fields, or for a choice among them", () => {
    expect(
      mapNotice({
        ...none,
        numbers: [],
        latitude: undefined,
        longitude: undefined,
      }),
    ).toBe("add-fields");
    expect(
      mapNotice({
        ...none,
        numbers: two.slice(0, 1),
        latitude: "x",
        longitude: undefined,
      }),
    ).toBe("add-fields");
    expect(
      mapNotice({ ...none, numbers: two, latitude: "x", longitude: undefined }),
    ).toBe("choose-fields");
  });
});
