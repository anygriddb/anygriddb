/**
 * What an API token may call, by what a procedure is rather than by a list
 * of what it may not do: a procedure added later is covered without a word.
 */
import type { TokenScope } from "../auth/tokens.js";

/**
 * The one change a read-only token may ask for: an export of what it can
 * read, which runs as a job and is a read for everything but its name.
 */
const READ_ONLY_CALLS: ReadonlySet<string> = new Set(["jobs.startExport"]);

/**
 * Refused to every token: what brings the account into a base, and an
 * address that goes on serving rows once the token is revoked.
 */
const SESSION_ONLY: ReadonlySet<string> = new Set([
  "auth.pendingInvitations",
  "auth.answerInvitation",
  "auth.acceptInvitation",
  "catalog.renewCalendarFeed",
  "catalog.revokeCalendarFeed",
]);

/** What lists or changes the whole account, every base together. */
const WHOLE_ACCOUNT = /^(notifications|shortcuts)\./;

export function tokenMayCall(
  scope: TokenScope,
  type: "query" | "mutation" | "subscription",
  path: string,
): boolean {
  if (SESSION_ONLY.has(path)) return false;
  if (scope.baseIds && WHOLE_ACCOUNT.test(path)) return false;
  return !scope.readOnly || type === "query" || READ_ONLY_CALLS.has(path);
}
