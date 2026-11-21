import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "./trpc";

export function useSession() {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.session.current.queryOptions(),
    staleTime: 60_000,
    // Signed out is an answer (null), not a failure: what fails is the API
    // out of reach, as while it restarts. Two more tries ride that out.
    retry: 2,
  });
}

/**
 * Whether the server answers this session's reads yet. Where the policy
 * asks an account for a second factor (ADR 0043), everything but the
 * account's own setup is refused until it has one: the lists every page
 * shares (the bases, the pins, the notifications, the jobs) wait for it
 * rather than be refused, one after the other, on a new account's first
 * page.
 */
export function mayRead(
  user: { mfaRequired: boolean; mfaEnrolled: boolean } | null | undefined,
): boolean {
  return Boolean(user) && !(user?.mfaRequired && !user.mfaEnrolled);
}

/** `mayRead` of the session the page has. */
export function useMayRead(): boolean {
  return mayRead(useSession().data);
}

export function useCatalog(enabled = true) {
  const trpc = useTRPC();
  const reads = useMayRead();
  return useQuery({
    ...trpc.catalog.list.queryOptions(),
    enabled: enabled && reads,
    staleTime: 30_000,
  });
}
