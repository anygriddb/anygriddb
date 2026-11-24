/**
 * Freezes coerce / assert / sameAsSeen for a fixed sample of every writable
 * field type. A definition refactor must leave these values unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  assertCellValue,
  coerceCellValue,
  type CellColumn,
  type CellValue,
} from "./cell-values";
import { WRITABLE_TYPES, type WritableType } from "./field-types";
import { sameAsSeen } from "./seen-cell";

const OPTIONS = [
  { name: "Open", color: "green" as const },
  { name: "Closed", color: "gray" as const },
];

const PERSON = "11111111-1111-4111-8111-111111111111";
const FILE = "attABCDEFGHIJKLMNOPQRSTUV";

/** One accepted raw input per writable type, and the value kept after coerce. */
const SAMPLES: Record<
  WritableType,
  { column: CellColumn; raw: unknown; kept: CellValue }
> = {
  text: {
    column: { fieldType: "text", config: {} },
    raw: " Hello ",
    kept: " Hello ",
  },
  long_text: {
    column: { fieldType: "long_text", config: {} },
    raw: "a\nb",
    kept: "a\nb",
  },
  number: {
    column: { fieldType: "number", config: {} },
    raw: "7.2500",
    kept: "7.25",
  },
  boolean: {
    column: { fieldType: "boolean", config: {} },
    raw: true,
    kept: true,
  },
  date: {
    column: { fieldType: "date", config: {} },
    raw: "2026-02-28",
    kept: "2026-02-28",
  },
  datetime: {
    column: { fieldType: "datetime", config: {} },
    raw: "2026-01-10T09:30:00.250Z",
    kept: "2026-01-10T09:30:00.250Z",
  },
  single_select: {
    column: { fieldType: "single_select", config: { options: OPTIONS } },
    raw: "Open",
    kept: "Open",
  },
  multi_select: {
    column: { fieldType: "multi_select", config: { options: OPTIONS } },
    raw: ["Open", "Closed"],
    kept: ["Open", "Closed"],
  },
  email: {
    column: { fieldType: "email", config: {} },
    raw: "a@example.org",
    kept: "a@example.org",
  },
  url: {
    column: { fieldType: "url", config: {} },
    raw: "https://example.org/path",
    kept: "https://example.org/path",
  },
  phone: {
    column: { fieldType: "phone", config: {} },
    raw: "+33 1 23 45 67 89",
    kept: "+33 1 23 45 67 89",
  },
  color: {
    column: { fieldType: "color", config: {} },
    raw: "#ABC",
    kept: "#aabbcc",
  },
  place: {
    column: { fieldType: "place", config: {} },
    raw: "48.8566, 2.3522",
    kept: "48.8566,2.3522",
  },
  json: {
    column: { fieldType: "json", config: {} },
    raw: '{"b":1,"a":2}',
    kept: '{"b": 1, "a": 2}',
  },
  rating: {
    column: { fieldType: "rating", config: { ratingMax: 5 } },
    raw: 3,
    kept: 3,
  },
  duration: {
    column: { fieldType: "duration", config: {} },
    raw: "3661",
    kept: 3661,
  },
  user: {
    column: { fieldType: "user", config: {} },
    raw: [PERSON],
    kept: [PERSON],
  },
  attachment: {
    column: { fieldType: "attachment", config: {} },
    raw: [FILE],
    kept: [FILE],
  },
};

describe("frozen cell values per writable type", () => {
  it("covers every WritableType exactly once", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...WRITABLE_TYPES].sort());
  });

  it("asserts, coerces, and compares as the freeze map says", () => {
    for (const type of WRITABLE_TYPES) {
      const sample = SAMPLES[type];
      expect(
        () => assertCellValue(sample.column, sample.kept),
        type,
      ).not.toThrow();
      expect(coerceCellValue(sample.column, sample.raw), type).toEqual(
        sample.kept,
      );
      expect(sameAsSeen(type, sample.kept, sample.kept), type).toBe(true);
      expect(sameAsSeen(type, sample.kept, null), type).toBe(false);
    }
  });
});
