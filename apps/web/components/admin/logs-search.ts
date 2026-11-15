import { z } from "zod";

const LEVELS = ["info", "warn", "error"] as const;
const SORTS = ["time", "level", "message", "request", "address"] as const;

/**
 * The process log's filters as the address keeps them. A value the page
 * does not know is dropped. The defaults (every kept line, newest first)
 * leave the address.
 */
export const logsSearchSchema = z.object({
  level: z.enum(LEVELS).optional().catch(undefined),
  q: z.string().trim().max(200).optional().catch(undefined),
  from: z.iso.datetime().optional().catch(undefined),
  to: z.iso.datetime().optional().catch(undefined),
  sort: z.enum(SORTS).optional().catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
});

export type LogsSearch = z.infer<typeof logsSearchSchema>;

export function parseLogsSearch(value: unknown): LogsSearch {
  return logsSearchSchema.parse(value);
}
export type LogsSort = (typeof SORTS)[number];

/** What `admin.logs` is asked. An inverted range is not asked. */
export function logsQuery(
  search: LogsSearch,
  page: { limit: number; offset: number },
) {
  return {
    level: search.level ?? ("info" as const),
    limit: page.limit,
    offset: page.offset,
    query: search.q || undefined,
    from: search.from,
    to: search.to,
    sort: search.sort ?? ("time" as const),
    direction: search.dir ?? ("desc" as const),
  };
}

/** The start sits after the end: the page says so and does not ask. */
export function logsRangeInvalid(search: LogsSearch): boolean {
  return Boolean(search.from && search.to && search.from > search.to);
}

/** The address after one change. A default value leaves it. */
export function nextLogs(
  current: LogsSearch,
  patch: Partial<LogsSearch>,
): LogsSearch {
  const merged: LogsSearch = { ...current, ...patch };
  const next: LogsSearch = {};
  if (merged.level && merged.level !== "info") next.level = merged.level;
  if (merged.q) next.q = merged.q;
  if (merged.from) next.from = merged.from;
  if (merged.to) next.to = merged.to;
  if (merged.sort && merged.sort !== "time") next.sort = merged.sort;
  if (merged.dir === "asc") next.dir = merged.dir;
  return next;
}

/** Clicking a column. Time starts newest first; the others start at A. */
export function sortLogs(current: LogsSearch, sort: LogsSort): LogsSearch {
  const active = (current.sort ?? "time") === sort;
  if (!active) {
    return nextLogs(current, { sort, dir: sort === "time" ? "desc" : "asc" });
  }
  const dir = (current.dir ?? "desc") === "desc" ? "asc" : "desc";
  return nextLogs(current, { sort, dir });
}
