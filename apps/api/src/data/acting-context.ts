import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The person an administrator is acting as, for this request only
 * (ADR 0091). Empty when they are themselves. A job has none.
 */
const acting = new AsyncLocalStorage<string | null>();

export function actingUserId(): string | null {
  const value = acting.getStore();
  return value ? value : null;
}

/** The rest of this call's writes name this person beside the author. */
export function runActing<T>(
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return acting.run(userId, fn);
}
