import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "./trpc";

export function useSession() {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.session.current.queryOptions(),
    staleTime: 60_000,
    retry: false,
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
