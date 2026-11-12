import type { ViewPatch } from "./view-toolbar";

/**
 * The settings still waiting for their save once `saved` is stored: a
 * setting changed again meanwhile keeps its newer value.
 */
export function withoutSaved(local: ViewPatch, saved: ViewPatch): ViewPatch {
  const next: Record<string, unknown> = { ...local };
  for (const [key, value] of Object.entries(saved)) {
    if (next[key] === value) Reflect.deleteProperty(next, key);
  }
  return next;
}

/**
 * Saves run one after another, in the order they were asked: two quick
 * changes of one setting are stored as they were made, the last one last.
 * A save that fails does not stop the next.
 */
export function saveQueue() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(save: () => Promise<T>): Promise<T> => {
    const next = last.then(save, save);
    last = next.catch(() => undefined);
    return next;
  };
}

/**
 * What a read of the rows asks for, written the same whatever the order
 * of each object's keys: a setting kept locally and the same setting as
 * the server stored it give one key.
 */
export function readKey(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : value,
  );
}
