/**
 * One guess at a time (ADR 0043). A wrong password or code is counted
 * after it is compared, so guesses that arrive together would all be
 * compared before the first one counts, and the lock would come late:
 * sixty sign-ins sent at once tried fifty-one passwords where the policy
 * allows ten. Guesses about one subject therefore take turns, and each
 * sees what the one before it left: a count, a lock, a challenge used up.
 *
 * A few may wait. Past that a guess is refused at once, so a flood holds
 * neither memory nor a connection. Turns are kept in memory, per process,
 * as rate limits are (ADR 0009): with several API processes, as many
 * guesses as processes may be compared together.
 */
import { AppError } from "@anygriddb/core";

/** Guesses about one subject that may wait behind the one being compared. */
export const MAX_WAITING_GUESSES = 4;

type Line = { length: number; last: Promise<void> };

const lines = new Map<string, Line>();

export async function inTurn<T>(
  subject: string,
  guess: () => Promise<T>,
): Promise<T> {
  const line = lines.get(subject) ?? { length: 0, last: Promise.resolve() };
  if (line.length > MAX_WAITING_GUESSES) {
    throw new AppError("too_many_attempts");
  }
  const before = line.last;
  let leave: () => void = () => undefined;
  line.last = new Promise<void>((resolve) => {
    leave = resolve;
  });
  line.length += 1;
  lines.set(subject, line);
  await before;
  try {
    return await guess();
  } finally {
    line.length -= 1;
    if (line.length === 0) lines.delete(subject);
    leave();
  }
}
