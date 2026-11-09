import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
} from "@anygriddb/ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  CopyPlus,
  FileUp,
  Database,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Table2,
  Trash,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useTrackJob } from "../../lib/jobs";
import { useTrashActions } from "../../lib/trash";
import { useChannel, useOnline } from "../../lib/realtime";
import { useCatalog } from "../../lib/session";
import { resolveShortcuts } from "../../lib/shortcut-list";
import { useShortcuts } from "../../lib/shortcuts";
import { trpc, useTRPC } from "../../lib/trpc";
import type { CatalogBase, CatalogTable } from "../../lib/types";
import { canManage } from "../../lib/types";
import { BrandMark } from "../brand/brand-mark";
import { ImportDialog } from "../table/import-dialog";
import { ConfirmDialog, PromptDialog } from "./dialogs";
import { NewBaseDialog } from "./new-base-dialog";
import { openCommandPalette } from "./command-palette";
import { JobsMenu } from "./jobs-menu";
import { NotificationBell } from "./notification-bell";
import { TrashDialog } from "./trash-dialog";
import { UserMenu } from "./user-menu";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { useSnapshotGaps } from "../../lib/snapshot-report";

type Dialog =
  | { kind: "create-base" }
  | { kind: "rename-base"; base: CatalogBase }
  | { kind: "delete-base"; base: CatalogBase }
  | { kind: "create-table"; base: CatalogBase }
  | { kind: "rename-table"; table: CatalogTable }
  | { kind: "delete-table"; table: CatalogTable; base: CatalogBase }
  | { kind: "import"; base: CatalogBase }
  | { kind: "trash"; base: CatalogBase }
  | null;

export function useInvalidateCatalog() {
  const queryClient = useQueryClient();
  const api = useTRPC();
  return () =>
    queryClient.invalidateQueries({ queryKey: api.catalog.list.queryKey() });
}

/** Pins or unpins a base or a table for its reader, from the sidebar. */
function PinButton(props: {
  pinned: boolean;
  name: string;
  onToggle: () => void;
}) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      className={cn(
        "rounded p-0.5 text-muted-foreground hover:text-foreground focus:opacity-100",
        props.pinned ? "opacity-60" : "opacity-0 group-hover:opacity-100",
      )}
      aria-label={
        props.pinned
          ? t`Unpin ${{ name: props.name }}`
          : t`Pin ${{ name: props.name }}`
      }
      aria-pressed={props.pinned}
      onClick={props.onToggle}
    >
      {props.pinned ? (
        <PinOff className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Pin className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

export function Sidebar({
  user,
}: {
  user: {
    displayName: string;
    email: string;
    mfaEnrolled: boolean;
    /** Whether the policy asks for a factor before creating a base. */
    mfaForBases?: boolean;
    /** Whether the policy lets this account create bases (ADR 0044). */
    canCreateBases?: boolean;
    isAdmin?: boolean;
  };
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const navigate = useNavigate();
  // The base and table of the page shown, whichever page it is.
  const params = useParams({ strict: false });
  const catalog = useCatalog();
  const online = useOnline();
  const invalidate = useInvalidateCatalog();
  const trackJob = useTrackJob();
  const snapshotGaps = useSnapshotGaps();
  const { trashed } = useTrashActions();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useChannel(params.baseId, (message) => {
    if (message.type === "catalog") void invalidate();
  });
  const bases = catalog.data ?? [];
  const shortcuts = useShortcuts();
  const { pinned } = resolveShortcuts(bases, shortcuts.data);

  async function act(action: () => Promise<unknown>, success?: string) {
    try {
      await action();
      await invalidate();
      if (success) toast.success(success);
    } catch (cause) {
      toast.error(errorText(cause));
      throw cause;
    }
  }

  async function duplicateBase(base: CatalogBase) {
    let jobId: string;
    try {
      ({ jobId } = await trpc.catalog.duplicateBase.mutate({
        baseId: base.id,
      }));
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    await trackJob(jobId, {
      label: t`Duplicating ${{ name: base.name }}…`,
      onDone: (job) => {
        void invalidate();
        const copy = job.result?.baseId;
        // A copy carries what a snapshot does; what it left out is said.
        const gaps = snapshotGaps(job.result);
        if (gaps.length > 0) toast.warning(gaps.join(" · "));
        return {
          message: t`Base copied`,
          action:
            typeof copy === "string"
              ? {
                  label: t`Open`,
                  onClick: () =>
                    void navigate({
                      to: "/b/$baseId",
                      params: { baseId: copy },
                    }),
                }
              : undefined,
        };
      },
    });
  }

  async function duplicate(
    base: CatalogBase,
    table: CatalogTable,
    withData: boolean,
  ) {
    let jobId: string;
    try {
      ({ jobId } = await trpc.catalog.duplicateTable.mutate({
        tableId: table.id,
        withData,
      }));
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    await trackJob(jobId, {
      label: t`Duplicating ${{ name: table.name }}…`,
      onDone: (job) => {
        void invalidate();
        const copy = job.result?.tableId;
        return {
          message: t`Table duplicated`,
          action:
            typeof copy === "string"
              ? {
                  label: t`Open`,
                  onClick: () =>
                    void navigate({
                      to: "/b/$baseId/t/$tableId/{-$viewId}",
                      params: { baseId: base.id, tableId: copy },
                    }),
                }
              : undefined,
        };
      },
    });
  }

  async function moveTable(
    base: CatalogBase,
    table: CatalogTable,
    delta: number,
  ) {
    const order = base.tables.map((item) => item.id);
    const index = order.indexOf(table.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const [moved] = order.splice(index, 1);
    if (moved) order.splice(target, 0, moved);
    await act(() =>
      trpc.catalog.reorderTables.mutate({ baseId: base.id, order }),
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex items-center gap-1 border-b border-border px-2 py-2">
        <Link
          to="/"
          aria-label={t`Home`}
          className="shrink-0 rounded-md p-1 hover:bg-muted"
        >
          <BrandMark className="h-6 w-6" />
        </Link>
        <UserMenu user={user} />
        <JobsMenu />
        <NotificationBell />
      </div>
      <button
        type="button"
        onClick={openCommandPalette}
        className="mx-2 mt-2 flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
      >
        <Search className="h-4 w-4" aria-hidden />
        <span className="flex-1 text-left">{t`Search`}</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label={t`Bases`}>
        {pinned.length > 0 ? (
          <section aria-label={t`Pinned`} className="mb-3">
            <span className="mb-1 block px-1 text-xs font-medium text-muted-foreground">
              {t`Pinned`}
            </span>
            <ul className="flex flex-col gap-0.5">
              {pinned.map((item) => (
                <li
                  key={item.kind === "base" ? item.base.id : item.table.id}
                  className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted"
                >
                  {item.kind === "base" ? (
                    <>
                      <Database
                        className="h-3.5 w-3.5 shrink-0 text-primary"
                        aria-hidden
                      />
                      <Link
                        to="/b/$baseId"
                        params={{ baseId: item.base.id }}
                        className="min-w-0 flex-1 truncate"
                      >
                        {item.base.name}
                      </Link>
                    </>
                  ) : (
                    <>
                      <Table2
                        className="h-3.5 w-3.5 shrink-0 opacity-70"
                        aria-hidden
                      />
                      <Link
                        to="/b/$baseId/t/$tableId/{-$viewId}"
                        params={{
                          baseId: item.base.id,
                          tableId: item.table.id,
                        }}
                        className="min-w-0 flex-1 truncate"
                      >
                        {item.table.name}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {item.base.name}
                        </span>
                      </Link>
                    </>
                  )}
                  <PinButton
                    pinned
                    name={
                      item.kind === "base" ? item.base.name : item.table.name
                    }
                    onToggle={() =>
                      void shortcuts.setPinned(
                        item.kind === "base"
                          ? { baseId: item.base.id }
                          : { tableId: item.table.id },
                        false,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t`Bases`}
          </span>
          {user.canCreateBases === false ? null : (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label={t`New base`}
              onClick={() => setDialog({ kind: "create-base" })}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
        {bases.length === 0 && catalog.isSuccess ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            {t`No bases yet.`}
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {bases.map((base) => {
            const open = !collapsed.has(base.id);
            const manage = canManage(base.role);
            return (
              <li key={base.id}>
                <div
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-1 py-1 text-sm hover:bg-muted",
                    params.baseId === base.id && "font-medium",
                  )}
                >
                  <button
                    type="button"
                    aria-label={open ? t`Collapse` : t`Expand`}
                    className="rounded p-0.5 text-muted-foreground"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(base.id)) next.delete(base.id);
                        else next.add(base.id);
                        return next;
                      })
                    }
                  >
                    {open ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <Database
                    className="h-4 w-4 shrink-0 text-primary"
                    aria-hidden
                  />
                  <Link
                    to="/b/$baseId"
                    params={{ baseId: base.id }}
                    className="min-w-0 flex-1 truncate"
                  >
                    {base.name}
                  </Link>
                  <PinButton
                    pinned={shortcuts.pinnedBases.has(base.id)}
                    name={base.name}
                    onToggle={() =>
                      void shortcuts.setPinned(
                        { baseId: base.id },
                        !shortcuts.pinnedBases.has(base.id),
                      )
                    }
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
                      aria-label={t`Base actions`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {manage ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            setDialog({ kind: "create-table", base })
                          }
                        >
                          <Plus className="h-4 w-4" aria-hidden />
                          {t`New table`}
                        </DropdownMenuItem>
                      ) : null}
                      {manage ? (
                        <DropdownMenuItem
                          onSelect={() => setDialog({ kind: "import", base })}
                        >
                          <FileUp className="h-4 w-4" aria-hidden />
                          {t`Import a file`}
                        </DropdownMenuItem>
                      ) : null}
                      {manage ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            setDialog({ kind: "rename-base", base })
                          }
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                          {t`Rename`}
                        </DropdownMenuItem>
                      ) : null}
                      {manage ? (
                        <DropdownMenuItem
                          onSelect={() => void duplicateBase(base)}
                        >
                          <CopyPlus className="h-4 w-4" aria-hidden />
                          {t`Duplicate base`}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        onSelect={() =>
                          void navigate({
                            to: "/b/$baseId/dashboards",
                            params: { baseId: base.id },
                          })
                        }
                      >
                        <LayoutDashboard className="h-4 w-4" aria-hidden />
                        {t`Dashboards`}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          void navigate({
                            to: "/b/$baseId/api",
                            params: { baseId: base.id },
                          })
                        }
                      >
                        <Code2 className="h-4 w-4" aria-hidden />
                        {t`API and documentation`}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          void navigate({
                            to: "/b/$baseId/settings",
                            params: { baseId: base.id },
                          })
                        }
                      >
                        <Settings className="h-4 w-4" aria-hidden />
                        {t`Settings and sharing`}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setDialog({ kind: "trash", base })}
                      >
                        <Trash className="h-4 w-4" aria-hidden />
                        {t`Trash`}
                      </DropdownMenuItem>
                      {manage ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            danger
                            onSelect={() =>
                              setDialog({ kind: "delete-base", base })
                            }
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                            {t`Delete base`}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {open ? (
                  <ul className="ml-5 flex flex-col gap-0.5 border-l border-border pl-2">
                    {base.tables.map((table, index) => (
                      <li key={table.id}>
                        <div
                          className={cn(
                            "group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted",
                            params.tableId === table.id &&
                              "bg-accent text-accent-foreground",
                          )}
                        >
                          <Table2
                            className="h-3.5 w-3.5 shrink-0 opacity-70"
                            aria-hidden
                          />
                          <Link
                            to="/b/$baseId/t/$tableId/{-$viewId}"
                            params={{ baseId: base.id, tableId: table.id }}
                            className="min-w-0 flex-1 truncate"
                          >
                            {table.name}
                          </Link>
                          <PinButton
                            pinned={shortcuts.pinnedTables.has(table.id)}
                            name={table.name}
                            onToggle={() =>
                              void shortcuts.setPinned(
                                { tableId: table.id },
                                !shortcuts.pinnedTables.has(table.id),
                              )
                            }
                          />
                          {manage ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
                                aria-label={t`Table actions`}
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    setDialog({ kind: "rename-table", table })
                                  }
                                >
                                  <Pencil className="h-4 w-4" aria-hidden />
                                  {t`Rename`}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={index === 0}
                                  onSelect={() =>
                                    void moveTable(base, table, -1)
                                  }
                                >
                                  <ArrowUp className="h-4 w-4" aria-hidden />
                                  {t`Move up`}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={index === base.tables.length - 1}
                                  onSelect={() =>
                                    void moveTable(base, table, 1)
                                  }
                                >
                                  <ArrowDown className="h-4 w-4" aria-hidden />
                                  {t`Move down`}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() =>
                                    void duplicate(base, table, false)
                                  }
                                >
                                  <Copy className="h-4 w-4" aria-hidden />
                                  {t`Duplicate structure`}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    void duplicate(base, table, true)
                                  }
                                >
                                  <CopyPlus className="h-4 w-4" aria-hidden />
                                  {t`Duplicate with rows`}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  danger
                                  onSelect={() =>
                                    setDialog({
                                      kind: "delete-table",
                                      table,
                                      base,
                                    })
                                  }
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden />
                                  {t`Delete table`}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      </li>
                    ))}
                    {manage ? (
                      <li>
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-muted"
                          onClick={() =>
                            setDialog({ kind: "create-table", base })
                          }
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden />
                          {t`Add a table`}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        {online ? (
          <Wifi className="h-3.5 w-3.5 text-primary" aria-hidden />
        ) : (
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
        )}
        {online ? t`Live` : t`Offline`}
      </div>

      <NewBaseDialog
        open={dialog?.kind === "create-base"}
        onOpenChange={(open) => !open && setDialog(null)}
        mfaEnrolled={user.mfaEnrolled || user.mfaForBases === false}
      />
      {dialog?.kind === "import" ? (
        <ImportDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          target={{ kind: "new", baseId: dialog.base.id }}
          onStarted={(started) => {
            void invalidate();
            void navigate({
              to: "/b/$baseId/t/$tableId/{-$viewId}",
              params: { baseId: dialog.base.id, tableId: started.tableId },
            });
          }}
        />
      ) : null}
      {dialog?.kind === "trash" ? (
        <TrashDialog
          baseId={dialog.base.id}
          baseName={dialog.base.name}
          onOpenChange={(open) => !open && setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "rename-base" ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`Rename base`}
          label={t`Base name`}
          initial={dialog.base.name}
          onSubmit={(name) =>
            act(() =>
              trpc.catalog.updateBase.mutate({ baseId: dialog.base.id, name }),
            )
          }
        />
      ) : null}
      {dialog?.kind === "delete-base" ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`Delete the base “${{ name: dialog.base.name }}”?`}
          description={t`The base and its tables go to the trash: you can restore it from the home page for 30 days.`}
          confirmLabel={t`Delete`}
          onConfirm={async () => {
            const base = dialog.base;
            await act(() =>
              trpc.catalog.deleteBase.mutate({ baseId: base.id }),
            );
            trashed(t`Base moved to the trash`, "base", base.id);
            if (params.baseId === base.id) void navigate({ to: "/" });
          }}
        />
      ) : null}
      {dialog?.kind === "create-table" ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`New table in ${{ name: dialog.base.name }}`}
          label={t`Table name`}
          submitLabel={t`Create`}
          onSubmit={async (name) => {
            let created: { id: string } | undefined;
            await act(async () => {
              created = await trpc.catalog.createTable.mutate({
                baseId: dialog.base.id,
                name,
                columns: [
                  { label: t`Name`, fieldType: "text" },
                  { label: t`Notes`, fieldType: "long_text" },
                  {
                    label: t`Status`,
                    fieldType: "single_select",
                    config: {
                      options: [
                        { name: t`To do`, color: "gray" },
                        { name: t`In progress`, color: "blue" },
                        { name: t`Done`, color: "green" },
                      ],
                    },
                  },
                ],
              });
            });
            if (created)
              void navigate({
                to: "/b/$baseId/t/$tableId/{-$viewId}",
                params: { baseId: dialog.base.id, tableId: created.id },
              });
          }}
        />
      ) : null}
      {dialog?.kind === "rename-table" ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`Rename table`}
          label={t`Table name`}
          initial={dialog.table.name}
          onSubmit={(name) =>
            act(() =>
              trpc.catalog.updateTable.mutate({
                tableId: dialog.table.id,
                name,
              }),
            )
          }
        />
      ) : null}
      {dialog?.kind === "delete-table" ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`Delete the table “${{ name: dialog.table.name }}”?`}
          description={t`The table, its views, and the links to it go to the base's trash for 30 days.`}
          confirmLabel={t`Delete`}
          onConfirm={async () => {
            const table = dialog.table;
            await act(() =>
              trpc.catalog.deleteTable.mutate({ tableId: table.id }),
            );
            trashed(t`Table moved to the trash`, "table", table.id);
            if (params.tableId === table.id)
              void navigate({
                to: "/b/$baseId",
                params: { baseId: dialog.base.id },
              });
          }}
        />
      ) : null}
    </aside>
  );
}
