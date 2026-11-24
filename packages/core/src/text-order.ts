/**
 * Orders two texts by their UTF-16 code units, the order `sort()` gives
 * without a compare function. It depends on no locale, so what is sorted
 * with it (the field names a seal hashes, for one) reads the same on every
 * server.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
