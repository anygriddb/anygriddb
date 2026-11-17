import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTRPC } from "../../lib/trpc";
import type { CatalogColumn, ViewConfig } from "../../lib/types";

/**
 * The summaries a grid shows under its fields, over every row of the view
 * rather than the rows read: asked of the server, and asked again when
 * the rows change.
 */
export function useAggregates(input: {
  tableId: string;
  viewId: string | undefined;
  search: string;
  config: ViewConfig;
  columns: readonly CatalogColumn[];
  /** Only a grid shows summaries. */
  enabled: boolean;
  /** Changes whenever a loaded row does (`RowsState.version`). */
  version: number;
}) {
  const { tableId, viewId, search, columns } = input;
  const api = useTRPC();
  const aggregations = (input.config.aggregations ?? {}) as Record<
    string,
    string
  >;
  const items = Object.entries(aggregations).flatMap(([column, fn]) =>
    columns.some((item) => item.name === column)
      ? [{ column, fn: fn as never }]
      : [],
  );
  const aggregates = useQuery({
    ...api.rows.aggregate.queryOptions({
      tableId,
      viewId,
      search: search || undefined,
      items,
    }),
    enabled: input.enabled && items.length > 0 && viewId !== undefined,
  });
  const refetch = aggregates.refetch;
  useEffect(() => {
    if (items.length > 0) void refetch();
  }, [input.version, items.length, refetch]);
  return { aggregations, values: aggregates.data?.values };
}
