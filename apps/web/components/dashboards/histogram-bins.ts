/**
 * The names of a histogram's bins, from the least and the greatest value
 * the server found: each bin by its two bounds, in the reader's language,
 * with as many decimals as tell two neighbouring bounds apart. One bin,
 * when every value is the same, is named by that value.
 */
export function binLabels(
  bounds: { lo: number; hi: number },
  bins: number,
  locale: string,
): string[] {
  const { lo, hi } = bounds;
  if (bins <= 1 || lo === hi) {
    return [new Intl.NumberFormat(locale).format(lo)];
  }
  const width = (hi - lo) / bins;
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(width)) + 1));
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: decimals,
  });
  return Array.from(
    { length: bins },
    (_, index) =>
      `${number.format(lo + width * index)} – ${number.format(
        // The last bin ends on the greatest value itself, not a sum
        // that may miss it by a rounding.
        index === bins - 1 ? hi : lo + width * (index + 1),
      )}`,
  );
}
