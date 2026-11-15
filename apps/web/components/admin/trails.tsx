import { plural } from "@lingui/core/macro";
import { Button, Input, Label, Select, Spinner } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import { datedName, downloadCsv } from "../../lib/download";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { SortHeader } from "../sort-header";
import { AdminPageSizeSelect, AdminTable, AdminTableHead } from "./admin-list";
import { useAdminPageSize } from "./admin-page-size";
import { useReadsAll } from "./admin-access";
import { useChangeActionLabel } from "./change-labels";
import { InstantRange } from "./instant-range";
import {
  CHANGE_ACTIONS,
  nextChanges,
  toggleChangesDir,
  trailRangeInvalid,
  type ChangesSearch,
} from "./trail-search";

function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** A retention purge, as the trail tells it. */
function purgedText(events: number, before: string): string {
  return plural(events, {
    one: `# event from before ${before} deleted: the trail is kept for a time`,
    other: `# events from before ${before} deleted: the trail is kept for a time`,
  });
}

/** The change trail: what was written, by whom, from where. */
export function ChangesTrail({
  search,
  onSearch,
}: {
  search: ChangesSearch;
  onSearch: (update: (current: ChangesSearch) => ChangesSearch) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  // An auditor exports too: the export is on the trail under their name.
  const readsAll = useReadsAll();
  const api = useTRPC();
  const invalid = trailRangeInvalid(search);
  const [cursors, setCursors] = useState<string[]>([]);
  const [pageSize, setPageSize] = useAdminPageSize();
  const serial = JSON.stringify(search);
  const [seen, setSeen] = useState(serial);
  if (serial !== seen) {
    setSeen(serial);
    setCursors([]);
  }
  const before = cursors.at(-1);
  const oldestFirst = (search.dir ?? "desc") === "asc";
  const log = useQuery({
    ...api.admin.audit.queryOptions({
      action: search.action,
      source: search.source || undefined,
      from: search.from,
      to: search.to,
      direction: search.dir ?? "desc",
      before,
      limit: pageSize,
    }),
    enabled: !invalid,
    placeholderData: invalid ? undefined : (previous) => previous,
  });
  /** What an export took out: never a value, its kind, format, and rows. */
  const exported = (item: {
    kind: string;
    format: string;
    rows: number | null;
  }) => {
    const format = item.format.toUpperCase();
    const what =
      {
        view: t`A view's rows, as ${{ format }}`,
        base: t`The base's file, as ${{ format }}`,
        access_report: t`Who has access, as ${{ format }}`,
        change_trail: t`The change trail, as ${{ format }}`,
        sign_in_trail: t`The sign-in trail, as ${{ format }}`,
        restore_point: t`A restore point of the base, kept on the instance`,
      }[item.kind] ?? item.kind;
    return item.rows === null
      ? what
      : `${what} · ${plural(item.rows, { one: "# row", other: "# rows" })}`;
  };
  const actionLabel = useChangeActionLabel();
  // What an event of the catalog changed, by the table it wrote. Events
  // from before the trail kept that say "Structure", as they did.
  const catalogLabel = (table: string | null) =>
    (table
      ? {
          data_tables: t`Table`,
          data_columns: t`Field`,
          relations: t`Link`,
          role_bindings: t`Role`,
          table_acls: t`Row and field rules`,
          column_acls: t`Row and field rules`,
          shares: t`Public link`,
          invitations: t`Invitation`,
          webhooks: t`Webhook`,
          automations: t`Automation`,
          groups: t`Group of accounts`,
          group_members: t`Member of a group`,
          group_roles: t`Role of a group`,
          calendar_feeds: t`Calendar feed`,
          scim_tokens: t`Provisioning (SCIM)`,
          sources: t`Source`,
          external_watches: t`Watched table`,
          external_syncs: t`Synced table`,
          bases: t`Base`,
          views: t`View`,
          dashboards: t`Dashboard`,
          dashboard_widgets: t`Dashboard widget`,
          table_folders: t`Folder`,
        }[table]
      : undefined) ?? t`Structure`;
  async function exportCsv() {
    try {
      const file = await trpc.admin.exportAudit.mutate({
        action: search.action,
        source: search.source || undefined,
        from: search.from,
        to: search.to,
        direction: search.dir ?? "desc",
      });
      downloadCsv(datedName("anygriddb-audit", "csv"), file.csv);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-action">{t`Action`}</Label>
          <Select
            reads
            id="audit-action"
            className="w-44"
            value={search.action ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              onSearch((current) =>
                nextChanges(current, {
                  action: CHANGE_ACTIONS.find((item) => item === value),
                }),
              );
            }}
          >
            <option value="">{t`All`}</option>
            {CHANGE_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-source">{t`Source`}</Label>
          <Input
            reads
            id="audit-source"
            className="w-44"
            placeholder="web, api, import, automation…"
            value={search.source ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              onSearch((current) =>
                nextChanges(current, { source: value.trim() || undefined }),
              );
            }}
          />
        </div>
        <InstantRange
          from={search.from}
          to={search.to}
          invalid={invalid}
          onChange={(next) => onSearch((current) => nextChanges(current, next))}
        />
        {readsAll ? (
          <Button
            reads
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => void exportCsv()}
          >
            <Download className="h-4 w-4" aria-hidden />
            {t`Export as CSV`}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t`The log shows who changed which fields. Values stay in each row's history, behind the table's access rights.`}
      </p>
      {log.isLoading && !invalid ? <Spinner /> : null}
      {invalid ? null : (
        <>
          <AdminTable tableClassName="text-xs">
            <AdminTableHead>
              <tr>
                <SortHeader
                  label={t`Date`}
                  active
                  descending={!oldestFirst}
                  onSort={() => onSearch(toggleChangesDir)}
                />
                <th className="px-2 py-1.5">{t`Author`}</th>
                <th className="px-2 py-1.5">{t`Table`}</th>
                <th className="px-2 py-1.5">{t`Action`}</th>
                <th className="px-2 py-1.5">{t`Fields`}</th>
                <th className="px-2 py-1.5">{t`Reason`}</th>
                <th className="px-2 py-1.5">{t`Source`}</th>
              </tr>
            </AdminTableHead>
            <tbody>
              {log.data?.events.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-muted-foreground">
                    {t`Nothing matches. Every write to a base, its fields, and its roles shows here, and every export, with who made it.`}
                  </td>
                </tr>
              ) : null}
              {(log.data?.events ?? []).map((event) => (
                <tr key={event.id} className="border-t border-border align-top">
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {date(event.occurredAt)}
                  </td>
                  <td className="px-2 py-1.5">{event.userName ?? "—"}</td>
                  <td className="px-2 py-1.5">
                    {event.tableName
                      ? `${event.baseName ?? ""} / ${event.tableName}`
                      : (event.baseName ?? "—")}
                    {event.recordId ? (
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        {event.recordId.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5">
                    {event.action === "catalog"
                      ? catalogLabel(event.catalogTable)
                      : actionLabel(event.action)}
                  </td>
                  <td className="px-2 py-1.5">
                    {event.exported
                      ? exported(event.exported)
                      : event.opened?.endedAt
                        ? t`${{ base: event.baseName ?? "—" }}, closed by the administrator who had opened it, on ${{ date: date(event.opened.endedAt) }}`
                        : event.opened
                          ? t`${{ base: event.baseName ?? "—" }}, opened by an administrator to read it, until ${{ date: date(event.opened.until) }}`
                          : event.purged
                            ? purgedText(
                                event.purged.events,
                                date(event.purged.before),
                              )
                            : event.fields
                                .map((name) =>
                                  name === "ag_position"
                                    ? t`the row's place`
                                    : name,
                                )
                                .join(", ") || "—"}
                  </td>
                  <td className="px-2 py-1.5">{event.reason ?? "—"}</td>
                  <td className="px-2 py-1.5">{event.source ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              reads
              size="sm"
              variant="ghost"
              disabled={cursors.length === 0}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              {oldestFirst ? t`Older` : t`Newer`}
            </Button>
            <Button
              reads
              size="sm"
              variant="ghost"
              disabled={!log.data?.next}
              onClick={() =>
                log.data?.next &&
                setCursors((current) => [...current, log.data.next as string])
              }
            >
              {oldestFirst ? t`Newer` : t`Older`}
            </Button>
            <AdminPageSizeSelect
              size={pageSize}
              onChange={(size) => {
                setPageSize(size);
                setCursors([]);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
