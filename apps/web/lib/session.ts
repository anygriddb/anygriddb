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

export function useCatalog(enabled = true) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.catalog.list.queryOptions(),
    enabled,
    staleTime: 30_000,
  });
}
