import { toDecimalString } from "@anygriddb/core";

export type SelectionSummary = {
  /** Cells the range covers among the loaded rows. */
  cells: number;
  /** Cells holding a value. */
  filled: number;
  /** Cells holding a number, summed and compared exactly (ADR 0023). */
  numbers: number;
  sum?: string;
  mean?: number;
  min?: string;
  max?: string;
};

function scaleOf(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

function units(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const count = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  return negative ? -count : count;
}

function fromUnits(count: bigint, scale: number): string {
  const negative = count < 0n;
  const digits = (negative ? -count : count)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Counts the cells of a selection and, over its numbers, their exact sum,
 * minimum, and maximum. The mean is a float: it is only shown.
 */
export function summarizeSelection(
  cells: ReadonlyArray<{ value: unknown; numeric: boolean }>,
): SelectionSummary {
  const decimals: string[] = [];
  let filled = 0;
  for (const cell of cells) {
    if (isEmpty(cell.value)) continue;
    filled += 1;
    if (!cell.numeric || Array.isArray(cell.value)) continue;
    const decimal =
      typeof cell.value === "number" || typeof cell.value === "string"
        ? toDecimalString(String(cell.value))
        : undefined;
    if (decimal !== undefined) decimals.push(decimal);
  }
  const summary: SelectionSummary = {
    cells: cells.length,
    filled,
    numbers: decimals.length,
  };
  if (decimals.length === 0) return summary;
  const scale = Math.max(...decimals.map(scaleOf));
  const scaled = decimals.map((value) => units(value, scale));
  let total = 0n;
  let low = scaled[0] ?? 0n;
  let high = low;
  for (const value of scaled) {
    total += value;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  summary.sum = fromUnits(total, scale);
  summary.min = fromUnits(low, scale);
  summary.max = fromUnits(high, scale);
  summary.mean = Number(summary.sum) / decimals.length;
  return summary;
}
