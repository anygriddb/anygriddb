/**
 * The whole number a person typed, if it lies within the bounds. Digits
 * only: `1e3`, `0x10`, or `12.5` is not read as a number near it.
 */
export function wholeNumberIn(
  text: string,
  min: number,
  max: number,
): number | null {
  const typed = text.trim();
  if (!/^[0-9]+$/.test(typed)) return null;
  const value = Number(typed);
  return value >= min && value <= max ? value : null;
}
