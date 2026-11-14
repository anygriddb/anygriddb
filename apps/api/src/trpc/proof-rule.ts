/**
 * Which calls of Administration ask for the proof again (ROADMAP #28):
 * the password or the second factor, unless one was given in the last
 * five minutes.
 */

/**
 * The changes that ask nothing: each one only takes access away at once,
 * tries something without keeping it, concerns the administrator alone,
 * or reads. Everything else that changes something asks, so a procedure
 * added later asks without a word: leaving one out of the proof is a
 * line written here, with its reason.
 */
export const NO_PROOF: ReadonlySet<string> = new Set([
  // The proof itself.
  "admin.stepUp",
  // Takes access away, at once: a session, a token, a link, an invitation.
  "admin.endSession",
  "admin.endUserSessions",
  "admin.endOtherSessions",
  "admin.access.revokeToken",
  "admin.access.switchOff",
  "admin.outbound.revoke",
  "admin.withdrawInvitation",
  // Ends the administrator's own reading of a base before its hour is up.
  "admin.baseOverview.close",
  // Lets a locked account try its own password again.
  "admin.unlock",
  // Stops a job; reads the update notice, or puts it away.
  "admin.cancelJob",
  "admin.checkRelease",
  "admin.dismissRelease",
  // The administrator's own: which alerts they are mailed, a test mail to
  // their own address.
  "admin.alertChoices.set",
  "admin.sendTestMail",
  // Reads a file and writes nothing.
  "admin.people.preview",
  // Reads, written to the change trail: an auditor makes them too, and an
  // auditor has no way to give the proof.
  "admin.exportAudit",
  "admin.exportAuthAudit",
  "admin.accessReport",
  // Tries a connection and keeps nothing.
  "admin.oidc.test",
  "admin.saml.test",
  "admin.siem.test",
  "admin.sources.test",
  "admin.sources.check",
  // Reads again what a source already exposes.
  "admin.sources.refreshTable",
  "admin.sources.syncNow",
]);

/** Whether a call asks for the proof: every change not named above. */
export function asksProof(
  type: "query" | "mutation" | "subscription",
  path: string,
): boolean {
  return type === "mutation" && !NO_PROOF.has(path);
}
