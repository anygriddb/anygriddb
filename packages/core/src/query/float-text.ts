/**
 * A float stored by a client's engine, read exactly (ADR 0118). Its engine
 * writes it in scientific notation with every digit it needs, a letter
 * first: `d` for a double, `f` for a single-precision float, `n` for a
 * decimal the engine keeps as one. What the row carries is the shortest
 * decimal that is that same stored value.
 */
import { numberToDecimal, toDecimalString } from "../decimal";

/** The key of a row's exact floats, by field, until they take their place. */
export const ROW_FLOATS = "ag_floats";

/** The fewest digits that read back as this very single-precision value. */
function shortestSingle(value: number): string | undefined {
  const single = Math.fround(value);
  for (let digits = 1; digits <= 9; digits += 1) {
    const text = single.toPrecision(digits);
    if (Math.fround(Number(text)) === single) return toDecimalString(text);
  }
  return undefined;
}

/** A coded float as a canonical decimal; undefined for what is not one. */
export function exactFloatText(coded: string): string | undefined {
  const kind = coded.charAt(0);
  const text = coded.slice(1);
  if (text === "") return undefined;
  if (kind === "n") return toDecimalString(text);
  if (kind !== "d" && kind !== "f") return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  return kind === "f" ? shortestSingle(value) : numberToDecimal(value);
}

/** The row with each exact float in its field, and the carrier gone. */
export function withExactFloats(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const carried = row[ROW_FLOATS];
  if (carried === undefined) return row;
  const { [ROW_FLOATS]: _carried, ...rest } = row;
  const floats: unknown =
    typeof carried === "string" ? JSON.parse(carried) : carried;
  if (floats && typeof floats === "object") {
    for (const [name, coded] of Object.entries(floats)) {
      if (typeof coded !== "string") continue;
      const text = exactFloatText(coded);
      if (text !== undefined) rest[name] = text;
    }
  }
  return rest;
}
