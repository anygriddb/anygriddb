import { Button, cn, Input, Label, Select, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTRPC } from "../../lib/trpc";
import { LoadFailed } from "../shell/load-failed";

const LEVELS = ["warn", "error", "info"] as const;
type Level = (typeof LEVELS)[number];

/**
 * Recent lines of this process (ADR 0087). Newest first. Warnings by
 * default: successful requests stay on the container's output.
 */
export function LogsTab() {
  const { t, i18n } = useLingui();
  const api = useTRPC();
  const [level, setLevel] = useState<Level>("warn");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const type = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery(value.trim()), 250);
  };
  const logs = useQuery({
    ...api.admin.logs.queryOptions({
      level,
      limit: 200,
      query: query || undefined,
    }),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.locale, {
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
    if (value === "error") return t`Errors`;
    if (value === "info") return t`All kept lines`;
    return t`Warnings`;
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="process-log-search">{t`Search`}</Label>
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
            value={level}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "warn" || value === "error" || value === "info") {
                setLevel(value);
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
      </div>
      <p className="text-xs text-muted-foreground">
        {t`These are the recent lines of this process, newest first. They are kept in memory and disappear when the process stops. The database and the file store keep their own logs where they run.`}
      </p>
      {logs.isError ? (
        <LoadFailed error={logs.error} onRetry={() => void logs.refetch()} />
      ) : null}
      {logs.isLoading ? <Spinner /> : null}
      {logs.data ? (
        // A long path or frame makes the table wider than the page: the
        // region scrolls, so a keyboard must be able to reach it.
        <div
          role="region"
          aria-label={t`Recent lines`}
          tabIndex={0}
          className="overflow-x-auto rounded-sm border border-border outline-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          <table className="w-full text-xs">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-2 py-1.5">{t`Time`}</th>
                <th className="px-2 py-1.5">{t`Level`}</th>
                <th className="px-2 py-1.5">{t`Message`}</th>
                <th className="px-2 py-1.5">{t`Request`}</th>
                <th className="px-2 py-1.5">{t`Address`}</th>
              </tr>
            </thead>
            <tbody>
              {logs.data.lines.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-2 py-3 text-muted-foreground">
                    {query
                      ? t`No line matches this search.`
                      : t`Nothing at this level since the process started.`}
                  </td>
                </tr>
              ) : null}
              {logs.data.lines.map((line) => (
                <tr key={line.seq} className="border-t border-border align-top">
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
