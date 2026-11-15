import { describe, expect, it } from "vitest";
import {
  assertCellValue,
  coerceCellValue,
  formatPlace,
  isColor,
  isPlace,
  parseColor,
  parsePlace,
} from "./cell-values";
import { parseColumnConfig } from "./field-config";
import {
  canBeRequired,
  isPrimaryType,
  isWritableType,
  physicalSqlType,
  storedValueKind,
} from "./field-types";
import {
  convertExpression,
  isConvertible,
  isMetadataConversion,
} from "./query/ddl";
import { isSideFieldType, sideColumnType } from "./query/external-write";

const color = { fieldType: "color" as const, config: {} };
const place = { fieldType: "place" as const, config: {} };

describe("a colour", () => {
  it("is kept in one spelling: six digits, in lower case, after the sign", () => {
    expect(isColor("#1f3fae")).toBe(true);
    for (const other of ["#1F3FAE", "1f3fae", "#abc", "#1f3fa", "blue", ""]) {
      expect(isColor(other)).toBe(false);
    }
    expect(() => assertCellValue(color, "#1f3fae")).not.toThrow();
    expect(() => assertCellValue(color, null)).not.toThrow();
    expect(() => assertCellValue(color, "#1F3FAE")).toThrow("Invalid cell");
    expect(() => assertCellValue(color, 2047918)).toThrow("Invalid cell");
  });

  it("is read as a person types it, and nothing else is", () => {
    expect(parseColor("#1F3FAE")).toBe("#1f3fae");
    expect(parseColor(" 1f3fae ")).toBe("#1f3fae");
    expect(parseColor("#AbC")).toBe("#aabbcc");
    expect(parseColor("abc")).toBe("#aabbcc");
    for (const other of ["#1f3fa", "#1f3fae0", "#ggg", "blue", "rgb(1,2,3)"]) {
      expect(parseColor(other)).toBeUndefined();
    }
    expect(coerceCellValue(color, "#ABC")).toBe("#aabbcc");
    expect(coerceCellValue(color, "")).toBeNull();
    expect(coerceCellValue(color, "blue")).toBeUndefined();
  });
});

describe("a place", () => {
  it("is kept as its latitude, a comma, its longitude: six decimals at most", () => {
    expect(formatPlace({ latitude: 48.8566, longitude: 2.3522 })).toBe(
      "48.8566,2.3522",
    );
    expect(formatPlace({ latitude: -33.86881234567, longitude: 151.2 })).toBe(
      "-33.868812,151.2",
    );
    expect(formatPlace({ latitude: -0, longitude: 0.0000001 })).toBe("0,0");
    expect(formatPlace({ latitude: 90, longitude: -180 })).toBe("90,-180");
    // Off the globe, or no number at all.
    expect(formatPlace({ latitude: 90.000001, longitude: 0 })).toBeUndefined();
    expect(formatPlace({ latitude: 0, longitude: 180.1 })).toBeUndefined();
    expect(formatPlace({ latitude: Number.NaN, longitude: 0 })).toBeUndefined();

    expect(isPlace("48.8566,2.3522")).toBe(true);
    for (const other of [
      "48.8566, 2.3522",
      "48.85660,2.3522",
      "48.85661234567,2.3522",
      "+48.8566,2.3522",
      "91,0",
      "Paris",
    ]) {
      expect(isPlace(other)).toBe(false);
    }
    expect(() => assertCellValue(place, "48.8566,2.3522")).not.toThrow();
    expect(() => assertCellValue(place, "48.8566, 2.3522")).toThrow(
      "Invalid cell",
    );
  });

  it("is read as a person types or pastes it", () => {
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    for (const typed of [
      "48.8566,2.3522",
      "48.8566, 2.3522",
      " 48.8566 ,2.3522 ",
      "48.8566 2.3522",
      "48.8566;2.3522",
      "48,8566; 2,3522",
      "48,8566 2,3522",
      "+48.8566, +2.3522",
    ]) {
      expect([typed, parsePlace(typed)]).toEqual([typed, paris]);
    }
    expect(parsePlace("-33.8688 151.2093")).toEqual({
      latitude: -33.8688,
      longitude: 151.2093,
    });
    expect(parsePlace("48, 2")).toEqual({ latitude: 48, longitude: 2 });
  });

  it("reads nothing where the two numbers cannot be told, or are off the globe", () => {
    for (const typed of [
      "48,8566, 2,3522",
      "1,2,3",
      "48.8566",
      "91, 0",
      "0, 180.5",
      "-90.5 0",
      "1234, 5",
      "48.8566 N, 2.3522 E",
      "abc",
      "",
    ]) {
      expect([typed, parsePlace(typed)]).toEqual([typed, undefined]);
    }
    expect(coerceCellValue(place, "48,8566; 2,3522")).toBe("48.8566,2.3522");
    expect(coerceCellValue(place, "95, 2")).toBeUndefined();
    expect(coerceCellValue(place, " ")).toBeNull();
  });

  it("reads tabs, line breaks and unbreakable spaces as spaces", () => {
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    for (const typed of [
      "48.8566\t2.3522",
      "48.8566,\u00a02.3522",
      "48,8566\u202f;\n2,3522",
      "\n48.8566   ,   2.3522\t",
    ]) {
      expect([typed, parsePlace(typed)]).toEqual([typed, paris]);
    }
  });

  it("gives up at once on a long text, however it is made", () => {
    // Longer than any place a person types.
    expect(parsePlace(`48.${"8".repeat(70)},2`)).toBeUndefined();
    // A run of spaces is read once: ten thousand of them cost no more.
    const started = Date.now();
    for (const filler of [" ", "\t", " ,", "; "]) {
      expect(parsePlace(`1${filler.repeat(10_000)}`)).toBeUndefined();
      expect(parsePlace(`1${filler.repeat(10_000)}x`)).toBeUndefined();
      expect(parsePlace(`${filler.repeat(10_000)}1 2!`)).toBeUndefined();
    }
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(parsePlace(`48.8566${" ".repeat(10_000)}2.3522`)).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
    });
  });
});

describe("both, as field types", () => {
  it("are written as text, may be required, and name no row", () => {
    for (const type of ["color", "place"] as const) {
      expect(isWritableType(type)).toBe(true);
      expect(physicalSqlType(type)).toBe("text");
      expect(storedValueKind(type)).toBe("text");
      expect(canBeRequired(type)).toBe(true);
      expect(isPrimaryType(type)).toBe(false);
      expect(parseColumnConfig(type, {})).toEqual({});
      expect(() => parseColumnConfig(type, { ratingMax: 5 })).toThrow();
    }
  });

  it("take a text field's values that read as one, and rewrite the column for it", () => {
    for (const type of ["color", "place"] as const) {
      expect(isConvertible("text", type)).toBe(true);
      // The same SQL type, and still a rewrite: what does not fit goes.
      expect(isMetadataConversion("text", type)).toBe(false);
      // Back to text, the values stay as they are.
      expect(isMetadataConversion(type, "text")).toBe(true);
      expect(isConvertible(type, "number")).toBe(true);
    }
    expect(convertExpression("text", "color", `"x"`)).toContain(
      `'^#?[0-9a-f]{6}$'`,
    );
    expect(convertExpression("text", "place", `"x"`)).toContain(
      "abs(p.lat) <= 90 and abs(p.lng) <= 180",
    );
    // A number is first written as text, then read the same way.
    expect(convertExpression("number", "place", `"x"`)).toContain(
      `trim_scale("x")::text`,
    );
    expect(() => convertExpression("attachment", "color", `"x"`)).toThrow(
      "Invalid conversion",
    );
  });

  it("are kept beside a client's table on each of the five engines", () => {
    for (const type of ["color", "place"] as const) {
      expect(isSideFieldType(type)).toBe(true);
    }
    expect(sideColumnType("postgres", "color")).toBe("text");
    expect(sideColumnType("mysql", "place")).toBe("varchar(40)");
    expect(sideColumnType("mariadb", "color")).toBe("varchar(7)");
    expect(sideColumnType("sqlserver", "place")).toBe("varchar(40)");
    expect(sideColumnType("oracle", "color")).toBe("varchar2(7)");
  });
});
