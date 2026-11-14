import type { ActivityEvent } from "@anygriddb/core";
import { Avatar, Button, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatDate } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useCatalog } from "../../lib/session";
import { useTRPC } from "../../lib/trpc";
import { LoadFailed } from "./load-failed";
import { EmptyState, NotebookPage } from "./notebook-page";

/**
 * What was done in a base, newest first, as the reader may read it: the
 * tables and fields they see, by name, never a value. A row's values are
 * in its history, in the record panel.
 */
export function BaseActivity({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const api = useTRPC();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === baseId);
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const activity = useQuery({
    ...api.catalog.baseActivity.queryOptions({ baseId, before, limit: 50 }),
    placeholderData: keepPreviousData,
  });
  const list = new Intl.ListFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    type: "conjunction",
  });

  /** The event as one sentence: who, what, and where. */
  function sentence(event: ActivityEvent): string {
    const name = event.by.name;
    const table = event.table;
    const row = event.row;
    switch (event.kind) {
      case "row_added":
        return row
          ? t`${{ name }} added “${{ row }}” to ${{ table }}`
          : t`${{ name }} added a row to ${{ table }}`;
      case "row_changed": {
        const fields = list.format(event.fields);
        return row
          ? t`${{ name }} changed ${{ fields }} of “${{ row }}” in ${{ table }}`
          : t`${{ name }} changed ${{ fields }} of a row in ${{ table }}`;
      }
      case "row_moved":
        return row
          ? t`${{ name }} moved “${{ row }}” in ${{ table }}`
          : t`${{ name }} moved a row in ${{ table }}`;
      case "row_deleted":
        return row
          ? t`${{ name }} deleted “${{ row }}” from ${{ table }}`
          : t`${{ name }} deleted a row from ${{ table }}`;
      case "row_submitted":
        return row
          ? t`${{ name }} submitted “${{ row }}” for review in ${{ table }}`
          : t`${{ name }} submitted a row for review in ${{ table }}`;
      case "row_locked":
        return row
          ? t`${{ name }} locked “${{ row }}” in ${{ table }}`
          : t`${{ name }} locked a row in ${{ table }}`;
      case "row_unlocked":
        return row
          ? t`${{ name }} unlocked “${{ row }}” in ${{ table }}`
          : t`${{ name }} unlocked a row in ${{ table }}`;
      case "row_signed":
        return row
          ? t`${{ name }} signed “${{ row }}” in ${{ table }}`
          : t`${{ name }} signed a row in ${{ table }}`;
      case "field_added":
        return t`${{ name }} added the field ${{ field: event.field ?? "" }} to ${{ table }}`;
      case "field_changed":
        return event.before
          ? t`${{ name }} renamed the field ${{ before: event.before }} to ${{ field: event.field ?? "" }} in ${{ table }}`
          : t`${{ name }} changed the field ${{ field: event.field ?? "" }} in ${{ table }}`;
      case "field_deleted":
        return t`${{ name }} deleted the field ${{ field: event.field ?? "" }} from ${{ table }}`;
      case "table_added":
        return t`${{ name }} created the table ${{ table }}`;
      case "table_renamed":
        return t`${{ name }} renamed the table ${{ before: event.before ?? "" }} to ${{ table }}`;
    }
  }

  const events = activity.data?.events ?? [];
  return (
    <NotebookPage
      title={t`Activity`}
      description={
        base
          ? t`What was done in ${{ base: base.name }}, newest first: in the tables and fields you see, without their values. A row's values are in its history.`
          : undefined
      }
    >
      {activity.isLoading ? <Spinner /> : null}
      {activity.isError ? (
        <LoadFailed
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      ) : null}
      {activity.data && events.length === 0 ? (
        <EmptyState
          title={t`Nothing yet.`}
          description={t`What people add, change, and delete in this base's tables shows here.`}
        />
      ) : null}
      {events.length > 0 ? (
        <ul className="divide-y divide-rule">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex items-start gap-3 py-2.5 text-sm"
            >
              <Avatar name={event.by.name} />
              <div className="min-w-0 flex-1">
                <p>{sentence(event)}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(event.at, locale, undefined, true)}
                </p>
              </div>
              {event.rowId && event.row ? (
                <Link
                  to="/b/$baseId/t/$tableId/{-$viewId}"
                  params={{ baseId, tableId: event.tableId }}
                  search={{ row: event.rowId }}
                  className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
                  aria-label={t`Open “${{ row: event.row }}”`}
                >
                  {t`Open`}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={cursors.length === 0}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          {t`Newer`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!activity.data?.next}
          onClick={() => {
            const next = activity.data?.next;
            if (next) setCursors((current) => [...current, next]);
          }}
        >
          {t`Older`}
        </Button>
      </div>
    </NotebookPage>
  );
}
