import type { Groups } from "../grid/use-rows";

export type StackPlace = { start: number; count: number };

export type KanbanStack = { id: string; label: string; color?: string };

/**
 * Where each stack's rows start in the view's grouped order, and how many
 * there are, by the stack field's value ("" for none): the database
 * groups them.
 */
export function stackPlaces(
  groups: Groups | undefined,
): Map<string, StackPlace> {
  const places = new Map<string, StackPlace>();
  for (const group of groups ?? []) {
    if (group.depth !== 1 || group.start === undefined) continue;
    const key = group.keys[0];
    places.set(typeof key === "string" ? key : "", {
      start: group.start,
      count: group.count,
    });
  }
  return places;
}

/**
 * The stacks a kanban shows: no value first, then each option in its
 * order, then each value no longer among the options, after them.
 */
export function kanbanStacks(
  options: ReadonlyArray<{ name: string; color?: string }>,
  places: ReadonlyMap<string, StackPlace>,
): KanbanStack[] {
  return [
    { id: "", label: "" },
    ...options.map((option) => ({
      id: option.name,
      label: option.name,
      ...(option.color ? { color: option.color } : {}),
    })),
    ...[...places.keys()]
      .filter((key) => key && !options.some((option) => option.name === key))
      .map((key) => ({ id: key, label: key })),
  ];
}
