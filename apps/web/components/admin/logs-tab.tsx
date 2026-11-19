import { Button, cn, Input, Label, Select, Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTRPC } from "../../lib/trpc";
import { SortHeader } from "../sort-header";
import { LoadFailed } from "../shell/load-failed";
import { AdminPager, AdminTable, AdminTableHead } from "./admin-list";
import { useAdminPage, useAdminPageSize } from "./admin-page-size";
import { InstantRange } from "./instant-range";
import {
  logsQuery,
  logsRangeInvalid,
  nextLogs,
  sortLogs,
  type LogsSearch,
  type LogsSort,
} from "./logs-search";
import { intlLocale } from "../../lib/format";

const LEVELS = ["info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

/**
 * Recent lines of this process (ADR 0087). Every kept line, newest first,
 * until the reader narrows them. The choice stays in the address.
 */
export function LogsTab({
  search,
  onSearch,
}: {
  search: LogsSearch;
  onSearch: (update: (current: LogsSearch) => LogsSearch) => void;
}) {
  const { t, i18n } = useLingui();
  const api = useTRPC();
  const invalid = logsRangeInvalid(search);
  const [pageSize, setPageSize] = useAdminPageSize();
  const {
    page: pageNum,
    setPage,
    offset,
    limit,
  } = useAdminPage(
    pageSize,
    `${search.level ?? "info"}:${search.q ?? ""}:${search.from ?? ""}:${search.to ?? ""}:${search.sort ?? "time"}:${search.dir ?? "desc"}`,
  );
  const [text, setText] = useState(search.q ?? "");
  const [seen, setSeen] = useState(search.q);
  if (search.q !== seen) {
    setSeen(search.q);
    setText(search.q ?? "");
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const type = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onSearch((current) =>
        nextLogs(current, { q: value.trim() || undefined }),
      );
    }, 250);
  };
  const logs = useQuery({
    ...api.admin.logs.queryOptions(logsQuery(search, { limit, offset })),
    enabled: !invalid,
    refetchInterval: invalid ? false : 5_000,
    placeholderData: invalid ? undefined : (previous) => previous,
  });
  const when = (iso: string) =>
    new Date(iso).toLocaleString(intlLocale(i18n.locale), {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  const levelLabel = (value: string) => {
    if (value === "fatal") return t`Fatal`;
    if (value === "error") return t`Error`;
    if (value === "warn") return t`Warning`;
    return t`Info`;
  };
  const showLabel = (value: Level) => {
    if (value === "info") return t`All kept lines`;
    if (value === "error") return t`Errors`;
    return t`Warnings`;
  };
  const sort = search.sort ?? "time";
  const descending = (search.dir ?? "desc") === "desc";
  const header = (key: LogsSort, label: string) => (
    <SortHeader
      label={label}
      active={sort === key}
      descending={sort === key && descending}
      onSort={() => onSearch((current) => sortLogs(current, key))}
    />
  );
  const copy = async (line: {
    time: string;
    level: string;
    message: string;
    request?: { method: string; url: string; remoteAddress?: string };
  }) => {
    const body = [
      when(line.time),
      levelLabel(line.level),
      line.message,
      line.request ? `${line.request.method} ${line.request.url}` : "",
      line.request?.remoteAddress ?? "",
    ]
      .filter((part) => part !== "")
      .join("\n");
    try {
      await navigator.clipboard.writeText(body);
      toast.success(t`Copied`);
    } catch {
      toast.error(t`Could not copy.`);
    }
  };
  const page = logs.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="process-log-search">{t`Search the lines`}</Label>
          <Input
            reads
            id="process-log-search"
            type="search"
            className="w-64 max-w-full"
            value={text}
            onChange={(event) => type(event.target.value)}
            placeholder={t`A word in a message, a path, or a code`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="process-log-level">{t`Show`}</Label>
          <Select
            reads
            id="process-log-level"
            className="w-52"
            value={search.level ?? "info"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "warn" || value === "error" || value === "info") {
                onSearch((current) => nextLogs(current, { level: value }));
              }
            }}
          >
            {LEVELS.map((value) => (
              <option key={value} value={value}>
                {showLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        <InstantRange
          from={search.from}
          to={search.to}
          invalid={invalid}
          onChange={(next) => onSearch((current) => nextLogs(current, next))}
        />
        <Button
          reads
          size="sm"
          variant="ghost"
          onClick={() => void logs.refetch()}
        >
          <RefreshCw
            className={cn("h-4 w-4", logs.isFetching && "animate-spin")}
            aria-hidden
          />
          {t`Refresh`}
        </Button>
        {Object.keys(search).length > 0 ? (
          <Button
            reads
            size="sm"
            variant="ghost"
            onClick={() => onSearch(() => ({}))}
          >{t`Clear filters`}</Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t`These are the recent lines of this process, newest first. They are kept in memory and disappear when the process stops. The database and the file store keep their own logs where they run.`}
      </p>
      {page && !invalid ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {page.lines.length < page.total
            ? t`${page.lines.length} of ${page.total} lines`
            : plural(page.total, { one: "# line", other: "# lines" })}
          {page.oldest
            ? t` The oldest still kept is ${{ time: when(page.oldest) }}.`
            : null}
        </p>
      ) : null}
      {logs.isError && !invalid ? (
        <LoadFailed error={logs.error} onRetry={() => void logs.refetch()} />
      ) : null}
      {logs.isLoading && !invalid ? <Spinner /> : null}
      {page && !invalid ? (
        <>
          <AdminTable
            role="region"
            aria-label={t`Recent lines`}
            tabIndex={0}
            className="focus-visible:outline-2 focus-visible:outline-ring"
            tableClassName="text-xs"
          >
            <AdminTableHead>
              <tr>
                {header("time", t`Time`)}
                {header("level", t`Level`)}
                {header("message", t`Message`)}
                {header("request", t`Request`)}
                {header("address", t`Address`)}
                <th className="px-2 py-1.5">
                  <span className="sr-only">{t`Copy`}</span>
                </th>
              </tr>
            </AdminTableHead>
            <tbody>
              {page.lines.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-3 text-muted-foreground">
                    {search.q
                      ? t`No line matches this search.`
                      : search.from || search.to
                        ? t`No line in this range.`
                        : t`Nothing at this level since the process started.`}
                  </td>
                </tr>
              ) : null}
              {page.lines.map((line) => (
                <tr
                  key={line.seq}
                  className={cn(
                    "border-t border-border align-top",
                    line.level === "error" || line.level === "fatal"
                      ? "shadow-[inset_3px_0_0_var(--color-danger)]"
                      : line.level === "warn"
                        ? "shadow-[inset_3px_0_0_var(--color-warning)]"
                        : undefined,
                  )}
                >
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {when(line.time)}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 whitespace-nowrap",
                      line.level === "error" || line.level === "fatal"
                        ? "font-medium text-danger"
                        : line.level === "warn"
                          ? "font-medium text-warning"
                          : undefined,
                    )}
                  >
                    {levelLabel(line.level)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="font-mono">{line.message}</span>
                    {line.code ? (
                      <span className="mt-0.5 block text-muted-foreground">
                        {line.code}
                      </span>
                    ) : null}
                    {line.client ? (
                      <span className="mt-0.5 block text-muted-foreground">
                        {line.client.kind} {line.client.path}
                        {line.client.message ? ` — ${line.client.message}` : ""}
                      </span>
                    ) : null}
                    {line.error ? (
                      <span className="mt-0.5 block text-muted-foreground">
                        {line.error.type}
                        {line.error.code ? ` ${line.error.code}` : ""}
                        {line.error.constraint
                          ? ` ${line.error.constraint}`
                          : ""}
                      </span>
                    ) : null}
                    {line.error?.stack ? (
                      <pre className="mt-1 font-mono break-all whitespace-pre-wrap text-muted-foreground">
                        {line.error.stack}
                      </pre>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                    {line.request
                      ? `${line.request.method} ${line.request.url}`
                      : "—"}
                    {line.status ? (
                      <span className="mt-0.5 block text-muted-foreground">
                        {line.status}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                    {line.request?.remoteAddress ?? "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <Button
                      reads
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(line)}
                    >
                      {t`Copy`}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          {page.total > 0 ? (
            <AdminPager
              total={page.total}
              offset={offset}
              pageSize={pageSize}
              onPageSize={setPageSize}
              onPrev={() => setPage(pageNum - 1)}
              onNext={() => setPage(pageNum + 1)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
