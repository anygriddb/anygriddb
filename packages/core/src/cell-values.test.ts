import { describe, expect, it } from "vitest";
import { assertCellValue, coerceCellValue, readCellValue } from "./cell-values";

const select = {
  fieldType: "single_select" as const,
  config: {
    options: [
      { name: "Open", color: "green" as const },
      { name: "Done", color: "gray" as const },
    ],
  },
};
const multi = { ...select, fieldType: "multi_select" as const };

describe("assertCellValue", () => {
  it("accepts typed values and rejects mismatches", () => {
    expect(() =>
      assertCellValue({ fieldType: "email", config: {} }, "a@example.org"),
    ).not.toThrow();
    expect(() =>
      assertCellValue({ fieldType: "email", config: {} }, "nope"),
    ).toThrow("Invalid cell");
    expect(() =>
      assertCellValue({ fieldType: "url", config: {} }, "javascript:alert(1)"),
    ).toThrow("Invalid cell");
    expect(() => assertCellValue(multi, ["Open", "Done"])).not.toThrow();
    expect(() => assertCellValue(multi, ["Open", "Open"])).toThrow(
      "Invalid cell",
    );
    expect(() => assertCellValue(select, "Other")).toThrow("Invalid cell");
    expect(() =>
      assertCellValue({ fieldType: "rating", config: { ratingMax: 5 } }, 6),
    ).toThrow();
    expect(() =>
      assertCellValue(
        { fieldType: "datetime", config: {} },
        "2026-11-07T10:00:00Z",
      ),
    ).not.toThrow();
    expect(() =>
      assertCellValue({ fieldType: "date", config: {} }, "2026-02-30"),
    ).toThrow();
    expect(() =>
      assertCellValue({ fieldType: "formula", config: {} }, 1),
    ).toThrow("Formula column is computed");
    expect(() =>
      assertCellValue({ fieldType: "autonumber", config: {} }, 1),
    ).toThrow("Column is read-only");
    expect(() =>
      assertCellValue({ fieldType: "row_id", config: {} }, "r1"),
    ).toThrow("Column is read-only");
    expect(() =>
      assertCellValue({ fieldType: "attachment", config: {} }, ["bad"]),
    ).toThrow("Invalid attachment");
  });
});

describe("a number field that refuses negatives", () => {
  const stock = { fieldType: "number" as const, config: { nonNegative: true } };
  const free = { fieldType: "number" as const, config: {} };

  it("takes zero and above, as a decimal text or a number", () => {
    for (const value of ["0", "12.50", "-0", "-0.00", 0, 3, null]) {
      expect(() => assertCellValue(stock, value)).not.toThrow();
    }
    // Pasted text goes through the same check.
    expect(coerceCellValue(stock, "7")).toBe("7");
  });

  it("refuses a value under zero, and only where the field says so", () => {
    for (const value of ["-1", "-0.01", -3]) {
      expect(() => assertCellValue(stock, value)).toThrow(
        "Negative number refused",
      );
      expect(() => assertCellValue(free, value)).not.toThrow();
    }
    // Loose input never throws: what the field refuses does not fit.
    expect(coerceCellValue(stock, "-7")).toBeUndefined();
    expect(coerceCellValue(free, "-7")).toBe("-7");
  });
});

describe("coerceCellValue", () => {
  it("parses pasted text per type and refuses what does not fit", () => {
    expect(
      coerceCellValue({ fieldType: "number", config: {} }, "1 234,5"),
    ).toBe("1234.5");
    // Exact: a float would round these (ADR 0023).
    expect(
      coerceCellValue({ fieldType: "number", config: {} }, "9007199254740993"),
    ).toBe("9007199254740993");
    expect(coerceCellValue({ fieldType: "number", config: {} }, 0.1)).toBe(
      "0.1",
    );
    expect(
      coerceCellValue({ fieldType: "number", config: {} }, "12abc"),
    ).toBeUndefined();
    expect(coerceCellValue({ fieldType: "boolean", config: {} }, "Oui")).toBe(
      true,
    );
    expect(
      coerceCellValue({ fieldType: "date", config: {} }, "17/11/2026"),
    ).toBe("2026-11-17");
    expect(coerceCellValue({ fieldType: "duration", config: {} }, "1:30")).toBe(
      5400,
    );
    expect(coerceCellValue(select, "open")).toBe("Open");
    expect(coerceCellValue(multi, "done, open")).toEqual(["Done", "Open"]);
    expect(coerceCellValue(multi, "done, unknown")).toBeUndefined();
    expect(coerceCellValue({ fieldType: "text", config: {} }, "")).toBeNull();
    expect(
      coerceCellValue(
        { fieldType: "user", config: { multiple: true } },
        "Ada",
        {
          resolveUser: (text) =>
            text === "Ada" ? "11111111-1111-4111-8111-111111111111" : undefined,
        },
      ),
    ).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});

describe("a duration sent as a JSON number", () => {
  const duration = { fieldType: "duration" as const, config: {} };

  it("keeps a whole number of seconds JSON holds exactly", () => {
    expect(() =>
      assertCellValue(duration, 9_007_199_254_740_991),
    ).not.toThrow();
    expect(() => assertCellValue(duration, 90.5)).not.toThrow();
  });

  it("refuses one past 2^53, which JSON has already rounded", () => {
    for (const value of [JSON.parse("9007199254740993"), 2 ** 63, 1e300]) {
      expect(() => assertCellValue(duration, value)).toThrow("Invalid cell");
    }
  });
});

describe("a list sent as such", () => {
  const marks = {
    fieldType: "multi_select" as const,
    config: {
      options: [
        { name: "one", color: "gray" as const },
        { name: "a,b", color: "gray" as const },
        { name: "semi;colon", color: "gray" as const },
      ],
    },
  };

  it("takes each item whole, an option holding a comma or a semicolon", () => {
    expect(coerceCellValue(marks, ["one", "a,b"])).toEqual(["one", "a,b"]);
    expect(coerceCellValue(marks, ["semi;colon", "ONE", "one"])).toEqual([
      "semi;colon",
      "one",
    ]);
    expect(coerceCellValue(marks, [" ", ""])).toBeNull();
  });

  it("refuses an item that is no option, or not a text, never splitting it", () => {
    // Written out, the same text is split: "a" and "b" are no options.
    expect(coerceCellValue(marks, "one, a,b")).toBeUndefined();
    expect(coerceCellValue(marks, ["a", "b"])).toBeUndefined();
    expect(coerceCellValue(marks, ["one", { name: "one" }])).toBeUndefined();
    expect(coerceCellValue(marks, ["one", true])).toBeUndefined();
  });
});

const number = { fieldType: "number" as const, config: {} };
const text = { fieldType: "text" as const, config: {} };
const longText = { fieldType: "long_text" as const, config: {} };
const rating = { fieldType: "rating" as const, config: { ratingMax: 5 } };
const duration = { fieldType: "duration" as const, config: {} };
const day = { fieldType: "date" as const, config: {} };
const usDay = {
  fieldType: "date" as const,
  config: { date: { format: "us" as const } },
};
const euDay = {
  fieldType: "date" as const,
  config: { date: { format: "eu" as const } },
};
const instant = { fieldType: "datetime" as const, config: {} };
const usInstant = {
  fieldType: "datetime" as const,
  config: { date: { format: "us" as const } },
};
const parisInstant = {
  fieldType: "datetime" as const,
  config: { date: { timeZone: "Europe/Paris" } },
};
const newYorkInstant = {
  fieldType: "datetime" as const,
  config: { date: { timeZone: "America/New_York" } },
};

describe("a number is read by the decimal mark declared", () => {
  it.each([
    ["1,234", ".", "1234"],
    ["1,234", ",", "1.234"],
    ["1,234.50", ".", "1234.5"],
    ["1,234.50", ",", "1234.5"],
    ["1.234,5", ".", "1234.5"],
    ["1.234,5", ",", "1234.5"],
    ["12,5", ".", "12.5"],
    ["12,5", ",", "12.5"],
    ["1,234,567", ".", "1234567"],
    ["1,234,567", ",", "1234567"],
    ["-1,234", ".", "-1234"],
    ["1 234,5", ",", "1234.5"],
    ["1 234", ",", "1234"],
    ["1,234.50 €", ".", "1234.5"],
  ] as const)("reads %s with mark %s as %s", (written, decimalMark, value) => {
    expect(coerceCellValue(number, written, { decimalMark })).toBe(value);
  });

  it.each(["1,234", "-1,234", "999,999", "1,234 €"])(
    "refuses %s when nothing says what its comma is",
    (written) => {
      expect(coerceCellValue(number, written)).toBeUndefined();
    },
  );

  it.each([
    ["12,5", "12.5"],
    ["0,123", "0.123"],
    ["1234,567", "1234.567"],
    ["1,234.50", "1234.5"],
    ["1.234,5", "1234.5"],
    ["1,234,567", "1234567"],
    ["1 234,5", "1234.5"],
    ["1.5", "1.5"],
    ["1e3", "1000"],
  ])("reads %s the one way it can be read", (written, value) => {
    expect(coerceCellValue(number, written)).toBe(value);
  });

  describe("where a comma is the decimal mark", () => {
    it.each(["1.234", "-1.234", "999.999", "12.345 €"])(
      "refuses %s, whose point could group thousands",
      (written) => {
        expect(readCellValue(number, written, { decimalMark: "," })).toEqual({
          refused: { code: "ambiguous_point" },
        });
      },
    );

    it.each([
      ["1.5", "1.5"],
      ["1.2345", "1.2345"],
      ["0.123", "0.123"],
      ["1234.567", "1234.567"],
      ["1.234,5", "1234.5"],
      ["1234", "1234"],
      ["1,234", "1.234"],
    ])("reads %s as %s", (written, value) => {
      expect(coerceCellValue(number, written, { decimalMark: "," })).toBe(
        value,
      );
    });

    it("keeps the canonical point with no language, or an English one", () => {
      expect(coerceCellValue(number, "1.234")).toBe("1.234");
      expect(coerceCellValue(number, "1.234", { decimalMark: "." })).toBe(
        "1.234",
      );
    });
  });

  it.each(["1,2,3", "12,", ",5", "1,5e3", "1 2 3", "12 5", "1.234.567"])(
    "refuses %s, which says no number",
    (written) => {
      expect(coerceCellValue(number, written, { decimalMark: "." })).toBe(
        undefined,
      );
    },
  );
});

describe("an integer past what JSON keeps exact", () => {
  it("is refused as a JSON number, and kept as text", () => {
    expect(coerceCellValue(number, 9007199254740991)).toBe("9007199254740991");
    expect(coerceCellValue(number, "9007199254740993")).toBe(
      "9007199254740993",
    );
    // eslint-disable-next-line no-loss-of-precision
    expect(coerceCellValue(number, 9007199254740993)).toBeUndefined();
    // eslint-disable-next-line no-loss-of-precision
    expect(coerceCellValue(text, 9007199254740993)).toBeUndefined();
    // eslint-disable-next-line no-loss-of-precision
    expect(coerceCellValue(text, [9007199254740993])).toBeUndefined();
    expect(coerceCellValue(number, 0.1)).toBe("0.1");
  });

  it("is refused by the strict check, as a JSON number only", () => {
    expect(() => assertCellValue(number, 9007199254740991)).not.toThrow();
    expect(() => assertCellValue(number, "9007199254740993")).not.toThrow();
    // eslint-disable-next-line no-loss-of-precision
    expect(() => assertCellValue(number, 9007199254740993)).toThrow(
      "Invalid cell",
    );
    expect(() => assertCellValue(number, 1e300)).toThrow("Invalid cell");
    expect(() => assertCellValue(number, 1.5)).not.toThrow();
  });
});

describe("what is too long or not whole is refused, never cut", () => {
  it("holds a text to its field's limit", () => {
    expect(coerceCellValue(text, "a".repeat(4_000))).toHaveLength(4_000);
    expect(coerceCellValue(text, "a".repeat(4_001))).toBeUndefined();
    expect(coerceCellValue(longText, "a".repeat(20_000))).toHaveLength(20_000);
    expect(coerceCellValue(longText, "a".repeat(20_001))).toBeUndefined();
  });

  it("takes a whole rating, and refuses the rest", () => {
    expect(coerceCellValue(rating, "3")).toBe(3);
    expect(coerceCellValue(rating, "★★★")).toBe(3);
    expect(coerceCellValue(rating, "2.5")).toBeUndefined();
    expect(coerceCellValue(rating, "3.7")).toBeUndefined();
    expect(coerceCellValue(rating, 2.5)).toBeUndefined();
    expect(coerceCellValue(rating, "★ good")).toBeUndefined();
  });
});

describe("a day is read as its field writes it", () => {
  it.each([
    ["2024-03-07", "2024-03-07"],
    ["17/03/2024", "2024-03-17"],
    ["17.3.2024", "2024-03-17"],
    ["03/17/2024", "2024-03-17"],
    ["04/04/2026", "2026-04-04"],
    ["March 7, 2024", "2024-03-07"],
    ["7 March 2024", "2024-03-07"],
    ["7 mars 2024", "2024-03-07"],
    ["1er février 2024", "2024-02-01"],
    ["2024/03/07", "2024-03-07"],
  ])("reads %s as %s", (written, value) => {
    expect(coerceCellValue(day, written)).toBe(value);
  });

  it("follows the order its field declares", () => {
    expect(coerceCellValue(usDay, "03/04/2026")).toBe("2026-03-04");
    expect(coerceCellValue(euDay, "03/04/2026")).toBe("2026-04-03");
    expect(coerceCellValue(usDay, "13/25/2026")).toBeUndefined();
    expect(coerceCellValue(usDay, "14/03/2026")).toBeUndefined();
    expect(coerceCellValue(euDay, "04/13/2026")).toBeUndefined();
    // The field's format wins over the reader's language.
    expect(
      coerceCellValue(usDay, "03/04/2026", { dayOrder: "day-first" }),
    ).toBe("2026-03-04");
  });

  it("takes the order of a language that fixes it", () => {
    expect(coerceCellValue(day, "03/04/2026", { dayOrder: "day-first" })).toBe(
      "2026-04-03",
    );
    expect(
      coerceCellValue(day, "04/13/2026", { dayOrder: "day-first" }),
    ).toBeUndefined();
  });

  it.each(["03/04/2026", "3.4.2026", "03-04-2026"])(
    "refuses %s, two days, with nothing to say which",
    (written) => {
      for (const field of [day, instant]) {
        expect(readCellValue(field, written)).toEqual({
          refused: { code: "ambiguous_date" },
        });
      }
    },
  );

  it("refuses a date and time whose day reads two ways", () => {
    expect(readCellValue(instant, "03/04/2026 14:30")).toEqual({
      refused: { code: "ambiguous_date" },
    });
    expect(coerceCellValue(instant, "13/04/2026 14:30")).toBe(
      "2026-04-13T14:30:00Z",
    );
  });

  it.each(["Room 5", "1", "12", "Lot 3", "March 7", "2026", "13/25/2026"])(
    "refuses %s",
    (written) => {
      expect(coerceCellValue(day, written)).toBeUndefined();
      expect(coerceCellValue(instant, written)).toBeUndefined();
    },
  );

  it("takes the years the control offers, and no day that does not exist", () => {
    for (const value of [
      "0001-01-01",
      "0050-06-15",
      "0099-12-31",
      "0004-02-29",
    ]) {
      expect(() => assertCellValue(day, value)).not.toThrow();
    }
    for (const value of [
      "0000-01-01",
      "0050-02-30",
      "0099-02-30",
      "0003-02-29",
    ]) {
      expect(() => assertCellValue(day, value)).toThrow("Invalid cell");
    }
  });
});

describe("an instant", () => {
  it("puts a day alone at midnight where its field is", () => {
    expect(coerceCellValue(parisInstant, "14/03/2026")).toBe(
      "2026-03-13T23:00:00Z",
    );
    expect(coerceCellValue(newYorkInstant, "14/03/2026")).toBe(
      "2026-03-14T04:00:00Z",
    );
    expect(coerceCellValue(instant, "14/03/2026")).toBe("2026-03-14T00:00:00Z");
    expect(
      coerceCellValue(instant, "14/03/2026", { timeZone: "Europe/Paris" }),
    ).toBe("2026-03-13T23:00:00Z");
  });

  it("prefers the field's zone to the reader's", () => {
    expect(
      coerceCellValue(parisInstant, "2026-07-01", {
        timeZone: "America/New_York",
      }),
    ).toBe("2026-06-30T22:00:00Z");
  });

  it("reads the month first where its field says so", () => {
    expect(coerceCellValue(usInstant, "03/04/2026")).toBe(
      "2026-03-04T00:00:00Z",
    );
  });

  it("reads a time without a zone where the field is, to the microsecond", () => {
    expect(coerceCellValue(parisInstant, "2026-07-01 14:30")).toBe(
      "2026-07-01T12:30:00Z",
    );
    expect(coerceCellValue(parisInstant, "13/07/2026 14:30:05.123456")).toBe(
      "2026-07-13T12:30:05.123456Z",
    );
    expect(coerceCellValue(usInstant, "3/7/2026 2:30 PM")).toBe(
      "2026-03-07T14:30:00Z",
    );
  });

  it("keeps an instant that says its zone", () => {
    expect(coerceCellValue(instant, "2026-07-01T14:30:00+02:00")).toBe(
      "2026-07-01T14:30:00+02:00",
    );
    expect(coerceCellValue(instant, "2026-07-01 14:30:00+02")).toBe(
      "2026-07-01T14:30:00+02:00",
    );
  });

  it("refuses a time the zone's clocks skip", () => {
    expect(coerceCellValue(parisInstant, "2026-03-29 02:30")).toBeUndefined();
  });

  it("stays within the years a field takes, once in UTC", () => {
    expect(() =>
      assertCellValue(instant, "9999-12-31T23:59:59Z"),
    ).not.toThrow();
    expect(() => assertCellValue(instant, "9999-12-31T23:59:59-12:00")).toThrow(
      "Invalid cell",
    );
    expect(() => assertCellValue(instant, "0001-01-01T00:00:00+14:00")).toThrow(
      "Invalid cell",
    );
  });
});

describe("a duration", () => {
  it.each(["1d 1:01", "1j 1:01"])("reads %s", (written) => {
    expect(coerceCellValue(duration, written)).toBe(90_060);
  });

  it("refuses an unknown unit", () => {
    expect(coerceCellValue(duration, "1x 1:01")).toBeUndefined();
  });
});

describe("a text nothing can keep", () => {
  const types = [
    "text",
    "long_text",
    "email",
    "url",
    "phone",
    "number",
    "date",
    "json",
  ] as const;

  it("refuses a NUL in any field, never removing it", () => {
    for (const fieldType of types) {
      expect(readCellValue({ fieldType, config: {} }, "a\0b")).toEqual({
        refused: { code: "invalid_cell" },
      });
    }
    expect(readCellValue(select, "Open\0")).toEqual({
      refused: { code: "invalid_cell" },
    });
  });

  it("refuses half of a surrogate pair", () => {
    expect(readCellValue({ fieldType: "text", config: {} }, "a\ud83d")).toEqual(
      { refused: { code: "invalid_cell" } },
    );
  });

  it("refuses a JSON document that spells a NUL, and keeps a backslash before u0000", () => {
    const json = { fieldType: "json" as const, config: {} };
    expect(readCellValue(json, '{"a":"x\\u0000"}')).toEqual({
      refused: { code: "invalid_cell" },
    });
    expect(readCellValue(json, '{"a\\u0000":1}')).toEqual({
      refused: { code: "invalid_cell" },
    });
    expect(readCellValue(json, '{"a":"x\\\\u0000"}')).toEqual({
      value: '{"a": "x\\\\u0000"}',
    });
  });

  it("keeps every other character", () => {
    expect(
      readCellValue({ fieldType: "text", config: {} }, "é 🌍 \u0001"),
    ).toEqual({ value: "é 🌍 \u0001" });
  });
});

describe("an instant's decimals follow its column", () => {
  const plain = { fieldType: "datetime" as const, config: {} };
  const seven = { ...plain, instantDigits: 7 };

  it("takes seven decimals where the column keeps them", () => {
    expect(() => {
      assertCellValue(seven, "2026-01-02T03:04:05.1234567+00:00");
    }).not.toThrow();
    expect(coerceCellValue(seven, "2026-01-02T03:04:05.1234567+00:00")).toBe(
      "2026-01-02T03:04:05.1234567+00:00",
    );
  });

  it("refuses them where it does not, and eight everywhere", () => {
    expect(() => {
      assertCellValue(plain, "2026-01-02T03:04:05.1234567+00:00");
    }).toThrow();
    expect(
      coerceCellValue(plain, "2026-01-02T03:04:05.1234567+00:00"),
    ).toBeUndefined();
    expect(() => {
      assertCellValue(seven, "2026-01-02T03:04:05.12345678+00:00");
    }).toThrow();
  });
});
