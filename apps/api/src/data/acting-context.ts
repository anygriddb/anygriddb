import { AsyncLocalStorage } from "node:async_hooks";

/** An administrator acting as a person, for one request (ADR 0091). */
export type Acting = { actorId: string; personId: string };

const acting = new AsyncLocalStorage<Acting | null>();

/** The person named beside the author. A job has none: it refuses to start. */
export function actingUserId(): string | null {
  return acting.getStore()?.personId ?? null;
}

/**
 * Whose field and row rules hold for this account in this request: the
 * person's while the administrator acts as them, and "me" is that person.
 * The administrator stays the author of what is written.
 */
export function rulesOwner(userId: string): string {
  const current = acting.getStore();
  return current?.actorId === userId ? current.personId : userId;
}

/** The rest of this call reads and writes as this administrator's person. */
export function runActing<T>(who: Acting | null, fn: () => T): T {
  return acting.run(who, fn);
}
