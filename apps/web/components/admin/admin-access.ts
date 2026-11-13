import { useSession } from "../../lib/session";

/**
 * Whether the person signed in reads all of Administration: an
 * administrator, or an auditor (ADR 0071), who changes nothing there.
 * What only an administrator may do asks the session's `isAdmin` itself.
 */
export function useReadsAll(): boolean {
  const session = useSession();
  return session.data?.isAdmin === true || session.data?.isAuditor === true;
}
