import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc";

/** The table's status circuit (ADR 0124), read once per surface. */
export function useTableCircuit(tableId: string) {
  const api = useTRPC();
  return useQuery(api.catalog.getCircuit.queryOptions({ tableId }));
}
