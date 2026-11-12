/**
 * The places, in the view, of the cards on one line of a gallery of
 * `count` cards set `lanes` to a line.
 */
export function cardsOf(line: number, lanes: number, count: number): number[] {
  const first = line * lanes;
  const end = Math.min(count, first + lanes);
  return Array.from(
    { length: Math.max(0, end - first) },
    (_, at) => first + at,
  );
}
