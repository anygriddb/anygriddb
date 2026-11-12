import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../../lib/types";
import { placeColumns, placeFilter } from "./map-places";

const column = (name: string, kind: string) =>
  ({ name, kind }) as unknown as CatalogColumn;

describe("placeColumns", () => {
  const columns = [
    column("name", "text"),
    column("latitude", "number"),
    column("lng", "number"),
    column("altitude", "number"),
  ];

  it("finds the coordinates by name among the numbers", () => {
    const found = placeColumns({}, columns);
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

  it("finds nothing in a table without numbers", () => {
    expect(placeColumns({}, [column("lat", "text")])).toMatchObject({
      latitude: undefined,
      longitude: undefined,
    });
  });
});

describe("placeFilter", () => {
  it("keeps the rows whose two coordinates are on the globe", () => {
    expect(placeFilter("lat", "lon")).toEqual({
      conjunction: "and",
      conditions: [
        { column: "lat", op: "is_between", value: ["-90", "90"] },
        { column: "lon", op: "is_between", value: ["-180", "180"] },
      ],
    });
  });
});
