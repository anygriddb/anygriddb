/** Upsert a column as the first sort/group level without dropping the rest. */

type LevelSpec = { column: string; direction: "asc" | "desc" };

export function upsertFirstLevel(
  levels: readonly LevelSpec[],
  next: LevelSpec,
  max: number,
): LevelSpec[] {
  const rest = levels.filter((level) => level.column !== next.column);
  return [next, ...rest].slice(0, max);
}
