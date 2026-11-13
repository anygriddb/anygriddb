/**
 * What an auditor may call in Administration (ROADMAP #34, ADR 0071):
 * every read, the exports, and nothing else.
 */

/**
 * What an auditor may call that is not a read: the exports, each written
 * to the change trail under their name (ROADMAP #31).
 */
export const AUDITOR_EXPORTS: ReadonlySet<string> = new Set([
  "admin.exportAudit",
  "admin.exportAuthAudit",
  "admin.accessReport",
]);

/**
 * The one read an auditor is kept out of: it goes out to a client's
 * database and lists every table there, exposed or not.
 */
export const AUDITOR_KEPT_OUT: ReadonlySet<string> = new Set([
  "admin.sources.tables",
]);

/**
 * The auditor's rule, whole (ADR 0071): every read of Administration, the
 * exports, and nothing else. It goes by what a procedure is, not by a
 * list of the reads: a procedure added later is covered without a word,
 * a query read and a mutation refused.
 */
export function auditorMayCall(
  type: "query" | "mutation" | "subscription",
  path: string,
): boolean {
  return (
    (type === "query" && !AUDITOR_KEPT_OUT.has(path)) ||
    AUDITOR_EXPORTS.has(path)
  );
}
