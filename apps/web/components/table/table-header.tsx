import { isCopySourceEngine } from "@anygriddb/core";
import { Avatar, Tooltip } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ENGINE_NAMES } from "../../lib/limits";
import type { Presence } from "../../lib/realtime";
import { useTRPC } from "../../lib/trpc";
import type { CatalogTable, Role, ViewItem } from "../../lib/types";
import { ENGINE_MARKS, EngineMark } from "../admin/engine-mark";
import { canEditView } from "./table-rights";
import { ViewTabs } from "./view-tabs";
import { formatInstant } from "../../lib/format";

/** One line: the table, where it lives, its views, who is here. */
export function TableHeader({
  baseId,
  table,
  views,
  activeId,
  role,
  presence,
}: {
  baseId: string;
  table: CatalogTable;
  views: ViewItem[];
  activeId: string | undefined;
  role: Role | null;
  presence: readonly Presence[];
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const tableId = table.id;
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card pr-2 pl-4">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <h1 className="max-w-64 truncate text-base font-semibold">
          {table.name}
        </h1>
        {table.external ? (
          // A client's table (ADR 0006): its name in the database, always in view.
          <Tooltip content={ENGINE_NAMES[table.external.engine]}>
            <span
              tabIndex={0}
              className="inline-flex h-[22px] max-w-56 items-center gap-1.5 rounded-md border border-border bg-background px-2 font-mono text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <EngineMark
                engine={table.external.engine}
                className="h-3.5 w-3.5"
                title={ENGINE_MARKS[table.external.engine].label}
              />
              <span className="truncate">
                {table.external.schema}.{table.external.name}
              </span>
            </span>
          </Tooltip>
        ) : null}
      </div>
      <ViewTabs
        baseId={baseId}
        tableId={tableId}
        views={views}
        activeId={activeId}
        role={role}
        userCanEditView={(view) => canEditView(view, role, true)}
        onChanged={() =>
          queryClient.invalidateQueries({
            queryKey: api.catalog.views.queryKey({ tableId }),
          })
        }
        onCreated={(view) =>
          void navigate({
            to: "/b/$baseId/t/$tableId/{-$viewId}",
            params: { baseId: baseId, tableId: tableId, viewId: view.id },
          })
        }
        className="flex-1 self-stretch"
      />
      <div
        role="group"
        className="flex shrink-0 -space-x-1.5"
        aria-label={t`People here`}
      >
        {presence.slice(0, 6).map((peer) => (
          <Tooltip key={peer.userId} content={peer.name}>
            <span
              role="img"
              aria-label={peer.name}
              tabIndex={0}
              className="rounded-full ring-2 ring-card outline-none focus-visible:ring-ring"
            >
              <Avatar name={peer.name} />
            </span>
          </Tooltip>
        ))}
      </div>
    </header>
  );
}

/** A table read from a copy (ADR 0034) says how fresh the copy is. */
export function CopyNote({
  external,
  locale,
}: {
  external: NonNullable<CatalogTable["external"]>;
  locale: "fr" | "en";
}) {
  const { t } = useLingui();
  const synced = external.synced;
  if (!synced) return null;
  return (
    <p
      role="note"
      className="border-b border-border bg-head px-4 py-1 text-xs text-muted-foreground"
    >
      {synced.at
        ? t`Copy of the client's database from ${{
            date: formatInstant(synced.at, locale),
          }}, refreshed every ${{ minutes: synced.intervalMinutes }} min: read-only`
        : isCopySourceEngine(external.engine)
          ? t`The copy has not arrived. The table stays empty until then.`
          : t`Copy in preparation: the table is read live until then`}
    </p>
  );
}

/**
 * What a view says of itself under its toolbar: its description, and that
 * the person's settings are not stored where they may not change it.
 */
export function ViewNotes({
  view,
  description,
  editable,
}: {
  view: ViewItem | undefined;
  description: unknown;
  editable: boolean;
}) {
  const { t } = useLingui();
  return (
    <>
      {typeof description === "string" && description ? (
        <p
          className="border-b border-border px-4 py-1.5 text-sm whitespace-pre-line text-muted-foreground"
          aria-label={t`View description`}
        >
          {description}
        </p>
      ) : null}
      {!editable && view ? (
        <p className="border-b border-border bg-accent/40 px-4 py-1 text-xs text-muted-foreground">
          {view.locked
            ? t`Locked view: your settings stay local.`
            : t`Your view settings stay local.`}
        </p>
      ) : null}
    </>
  );
}
