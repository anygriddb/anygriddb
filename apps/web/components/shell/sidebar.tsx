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
  Folder,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  ShieldCheck,
  Settings,
  Table2,
  Trash,
  Trash2,
} from "lucide-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTrackJob } from "../../lib/jobs";
import type { NavigationMode } from "../../lib/narrow-screen";
import { useTrashActions, useTrashDays } from "../../lib/trash";
import { useChannel } from "../../lib/realtime";
import { useCatalog } from "../../lib/session";
import { resolveShortcuts } from "../../lib/shortcut-list";
import { useShortcuts } from "../../lib/shortcuts";
import {
  readSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  writeSidebarWidth,
} from "../../lib/sidebar-width";
import { trpc, useTRPC } from "../../lib/trpc";
import type { CatalogBase, CatalogTable } from "../../lib/types";
import { canManage } from "../../lib/types";
import { BrandMark } from "../brand/brand-mark";
import { ImportDialog } from "../table/import-dialog";
import { ConfirmDialog, PromptDialog } from "./dialogs";
import { NewTableDialog } from "./new-table-dialog";
import { NewBaseDialog } from "./new-base-dialog";
import { SidebarSources } from "./sidebar-sources";
import { ResizeHandle } from "./resize-handle";
import { openCommandPalette } from "./command-palette";
import { JobsMenu } from "./jobs-menu";
import { NotificationBell } from "./notification-bell";
import { TrashDialog } from "./trash-dialog";
import { UserMenu } from "./user-menu";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { useSnapshotGaps } from "../../lib/snapshot-report";

type CatalogFolder = CatalogBase["folders"][number];

type Dialog =
  | { kind: "create-base" }
  | { kind: "rename-base"; base: CatalogBase }
  | { kind: "delete-base"; base: CatalogBase }
  | { kind: "create-table"; base: CatalogBase }
  | { kind: "create-folder"; base: CatalogBase }
  | { kind: "rename-folder"; base: CatalogBase; folder: CatalogFolder }
  | { kind: "delete-folder"; base: CatalogBase; folder: CatalogFolder }
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

/** One table line in the sidebar, at the root or inside a folder. */
function SidebarTableRow(props: {
  base: CatalogBase;
  table: CatalogTable;
  index: number;
  siblings: readonly CatalogTable[];
  manage: boolean;
  active: boolean;
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onMove: (delta: number) => void;
  onDuplicate: (withData: boolean) => void;
  onDelete: () => void;
  onMoveToFolder: (folderId: string | null) => void;
}) {
  const { t } = useLingui();
  const {
    base,
    table,
    index,
    siblings,
    manage,
    active,
    pinned,
    onPin,
    onRename,
    onMove,
    onDuplicate,
    onDelete,
    onMoveToFolder,
  } = props;
  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted",
          active && "bg-accent text-accent-foreground",
        )}
      >
        <Table2 className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        <Link
          to="/b/$baseId/t/$tableId/{-$viewId}"
          params={{ baseId: base.id, tableId: table.id }}
          className="min-w-0 flex-1 truncate"
        >
          {table.name}
        </Link>
        <PinButton pinned={pinned} name={table.name} onToggle={onPin} />
        {manage ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
              aria-label={t`Table actions`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onRename}>
                <Pencil className="h-4 w-4" aria-hidden />
                {t`Rename`}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index === 0}
                onSelect={() => onMove(-1)}
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
                {t`Move up`}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={index === siblings.length - 1}
                onSelect={() => onMove(1)}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
                {t`Move down`}
              </DropdownMenuItem>
              {base.folders.length > 0 || table.folderId ? (
                <>
                  <DropdownMenuSeparator />
                  {table.folderId ? (
                    <DropdownMenuItem onSelect={() => onMoveToFolder(null)}>
                      <Folder className="h-4 w-4" aria-hidden />
                      {t`Move out of folder`}
                    </DropdownMenuItem>
                  ) : null}
                  {base.folders
                    .filter((folder) => folder.id !== table.folderId)
                    .map((folder) => (
                      <DropdownMenuItem
                        key={folder.id}
                        onSelect={() => onMoveToFolder(folder.id)}
                      >
                        <Folder className="h-4 w-4" aria-hidden />
                        {t`Move to ${{ name: folder.name }}`}
                      </DropdownMenuItem>
                    ))}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onDuplicate(false)}>
                <Copy className="h-4 w-4" aria-hidden />
                {t`Duplicate structure`}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDuplicate(true)}>
                <CopyPlus className="h-4 w-4" aria-hidden />
                {t`Duplicate with rows`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={onDelete}>
                <Trash2 className="h-4 w-4" aria-hidden />
                {t`Delete table`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
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
  mode,
  onClose,
}: {
  /** Beside the page, or on a narrow screen folded away or open over it. */
  mode: NavigationMode;
  onClose: () => void;
  user: {
    displayName: string;
    email: string;
    mfaEnrolled: boolean;
    /** Whether the policy asks for a factor before creating a base. */
    mfaForBases?: boolean;
    /** Whether the policy lets this account create bases (ADR 0044). */
    canCreateBases?: boolean;
    isAdmin?: boolean;
    isSupport?: boolean;
  };
}) {
  const { t } = useLingui();
  const days = useTrashDays();
  const errorText = useErrorText();
  const navigate = useNavigate();
  // The base and table of the page shown, whichever page it is.
  const params = useParams({ strict: false });
  const catalog = useCatalog();
  const invalidate = useInvalidateCatalog();
  const trackJob = useTrackJob();
  const snapshotGaps = useSnapshotGaps();
  const { trashed } = useTrashActions();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(readSidebarWidth);
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    // Opened over the page: focus moves into it, as into a dialog.
    if (mode === "open") aside.current?.querySelector("a")?.focus();
  }, [mode]);
  useChannel(params.baseId, {
    message: (message) => {
      if (message.type === "catalog") void invalidate();
    },
    resync: () => {
      void invalidate();
    },
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
    siblings: readonly CatalogTable[],
    delta: number,
  ) {
    const order = siblings.map((item) => item.id);
    const index = order.indexOf(table.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const [moved] = order.splice(index, 1);
    if (moved) order.splice(target, 0, moved);
    await act(() =>
      table.folderId
        ? trpc.catalog.reorderFolderTables.mutate({
            folderId: table.folderId,
            order,
          })
        : trpc.catalog.reorderTables.mutate({ baseId: base.id, order }),
    );
  }

  async function moveFolder(
    base: CatalogBase,
    folder: CatalogFolder,
    delta: number,
  ) {
    const order = base.folders.map((item) => item.id);
    const index = order.indexOf(folder.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const [moved] = order.splice(index, 1);
    if (moved) order.splice(target, 0, moved);
    await act(() =>
      trpc.catalog.reorderFolders.mutate({ baseId: base.id, order }),
    );
  }

  return (
    <aside
      ref={aside}
      inert={mode === "closed"}
      className={cn(
        "relative flex shrink-0 flex-col border-r border-border bg-background",
        mode !== "docked" &&
          "fixed inset-y-0 left-0 z-40 max-w-[85vw] shadow-xl transition-transform motion-reduce:transition-none",
        mode === "closed" && "-translate-x-full",
      )}
      style={{ width }}
      onKeyDown={(event) => {
        if (mode === "open" && event.key === "Escape") onClose();
      }}
    >
      <div className="flex h-11 shrink-0 items-center px-2">
        <Link
          to="/"
          className="flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 pl-1.5 hover:bg-muted"
        >
          <BrandMark className="h-5 w-5" />
          <span className="truncate text-sm font-semibold">AnyGridDB</span>
        </Link>
      </div>
      <button
        type="button"
        onClick={openCommandPalette}
        className="mx-2 flex h-7 items-center gap-2 rounded-md border border-border bg-card px-2 text-sm text-muted-foreground hover:bg-muted"
      >
        <Search className="h-4 w-4" aria-hidden />
        <span className="flex-1 text-left">{t`Search`}</span>
        <Kbd>{t`Ctrl K`}</Kbd>
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
          <div className="px-1 py-2 text-sm">
            <p className="text-muted-foreground">{t`No bases yet.`}</p>
            {user.canCreateBases === false ? null : (
              <button
                type="button"
                className="mt-1 text-primary hover:underline"
                onClick={() => setDialog({ kind: "create-base" })}
              >
                {t`New base`}
              </button>
            )}
          </div>
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
                    {base.folders.map((folder, folderIndex) => {
                      const inFolder = base.tables.filter(
                        (table) => table.folderId === folder.id,
                      );
                      const folderOpen = !collapsed.has(folder.id);
                      return (
                        <li key={folder.id}>
                          <div className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
                            <button
                              type="button"
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                              aria-expanded={folderOpen}
                              aria-label={
                                folderOpen
                                  ? t`Collapse ${{ name: folder.name }}`
                                  : t`Expand ${{ name: folder.name }}`
                              }
                              onClick={() =>
                                setCollapsed((current) => {
                                  const next = new Set(current);
                                  if (next.has(folder.id))
                                    next.delete(folder.id);
                                  else next.add(folder.id);
                                  return next;
                                })
                              }
                            >
                              {folderOpen ? (
                                <ChevronDown
                                  className="h-3.5 w-3.5"
                                  aria-hidden
                                />
                              ) : (
                                <ChevronRight
                                  className="h-3.5 w-3.5"
                                  aria-hidden
                                />
                              )}
                            </button>
                            <Folder
                              className="h-3.5 w-3.5 shrink-0 opacity-70"
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {folder.name}
                            </span>
                            {manage ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
                                  aria-label={t`Folder actions`}
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      setDialog({
                                        kind: "rename-folder",
                                        base,
                                        folder,
                                      })
                                    }
                                  >
                                    <Pencil className="h-4 w-4" aria-hidden />
                                    {t`Rename`}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={folderIndex === 0}
                                    onSelect={() =>
                                      void moveFolder(base, folder, -1)
                                    }
                                  >
                                    <ArrowUp className="h-4 w-4" aria-hidden />
                                    {t`Move up`}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={
                                      folderIndex === base.folders.length - 1
                                    }
                                    onSelect={() =>
                                      void moveFolder(base, folder, 1)
                                    }
                                  >
                                    <ArrowDown
                                      className="h-4 w-4"
                                      aria-hidden
                                    />
                                    {t`Move down`}
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    danger
                                    onSelect={() =>
                                      setDialog({
                                        kind: "delete-folder",
                                        base,
                                        folder,
                                      })
                                    }
                                  >
                                    <Trash2 className="h-4 w-4" aria-hidden />
                                    {t`Delete folder`}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </div>
                          {folderOpen ? (
                            <ul className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2">
                              {inFolder.map((table, index) => (
                                <SidebarTableRow
                                  key={table.id}
                                  base={base}
                                  table={table}
                                  index={index}
                                  siblings={inFolder}
                                  manage={manage}
                                  active={params.tableId === table.id}
                                  pinned={shortcuts.pinnedTables.has(table.id)}
                                  onPin={() =>
                                    void shortcuts.setPinned(
                                      { tableId: table.id },
                                      !shortcuts.pinnedTables.has(table.id),
                                    )
                                  }
                                  onRename={() =>
                                    setDialog({ kind: "rename-table", table })
                                  }
                                  onMove={(delta) =>
                                    void moveTable(base, table, inFolder, delta)
                                  }
                                  onDuplicate={(withData) =>
                                    void duplicate(base, table, withData)
                                  }
                                  onDelete={() =>
                                    setDialog({
                                      kind: "delete-table",
                                      table,
                                      base,
                                    })
                                  }
                                  onMoveToFolder={(folderId) =>
                                    void act(() =>
                                      trpc.catalog.moveTableToFolder.mutate({
                                        tableId: table.id,
                                        folderId,
                                      }),
                                    )
                                  }
                                />
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                    {base.tables
                      .filter((table) => table.folderId === null)
                      .map((table, index, root) => (
                        <SidebarTableRow
                          key={table.id}
                          base={base}
                          table={table}
                          index={index}
                          siblings={root}
                          manage={manage}
                          active={params.tableId === table.id}
                          pinned={shortcuts.pinnedTables.has(table.id)}
                          onPin={() =>
                            void shortcuts.setPinned(
                              { tableId: table.id },
                              !shortcuts.pinnedTables.has(table.id),
                            )
                          }
                          onRename={() =>
                            setDialog({ kind: "rename-table", table })
                          }
                          onMove={(delta) =>
                            void moveTable(base, table, root, delta)
                          }
                          onDuplicate={(withData) =>
                            void duplicate(base, table, withData)
                          }
                          onDelete={() =>
                            setDialog({
                              kind: "delete-table",
                              table,
                              base,
                            })
                          }
                          onMoveToFolder={(folderId) =>
                            void act(() =>
                              trpc.catalog.moveTableToFolder.mutate({
                                tableId: table.id,
                                folderId,
                              }),
                            )
                          }
                        />
                      ))}
                    {manage ? (
                      <>
                        <li>
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-muted"
                            onClick={() =>
                              setDialog({ kind: "create-folder", base })
                            }
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                            {t`Add a folder`}
                          </button>
                        </li>
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
                      </>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        <SidebarSources bases={bases} />
      </nav>
      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <UserMenu user={user} />
        {user.isAdmin || user.isSupport ? (
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            aria-label={t`Administration`}
            title={t`Administration`}
            asChild
          >
            <Link to="/admin">
              <ShieldCheck className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        ) : null}
        <JobsMenu />
        <NotificationBell />
      </div>
      {mode === "docked" ? (
        <ResizeHandle
          width={width}
          keyboard
          label={t`Resize the sidebar`}
          bounds={{
            min: SIDEBAR_WIDTH_MIN,
            max: SIDEBAR_WIDTH_MAX,
            reset: SIDEBAR_WIDTH_DEFAULT,
          }}
          onResize={(next, phase) => {
            // While dragging, the panel alone changes width: the tree of
            // bases is drawn again once, when the drag ends.
            if (aside.current) aside.current.style.width = `${String(next)}px`;
            if (phase === "end") {
              setWidth(next);
              writeSidebarWidth(next);
            }
          }}
        />
      ) : null}

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
          description={t`The base and its tables go to the trash: you can restore it from the home page for ${{ days }} days.`}
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
      {dialog?.kind === "create-folder" ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`New folder in ${{ name: dialog.base.name }}`}
          label={t`Folder name`}
          initial=""
          onSubmit={(name) =>
            act(() =>
              trpc.catalog.createFolder.mutate({
                baseId: dialog.base.id,
                name,
              }),
            )
          }
        />
      ) : null}
      {dialog?.kind === "rename-folder" ? (
        <PromptDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`Rename folder`}
          label={t`Folder name`}
          initial={dialog.folder.name}
          onSubmit={(name) =>
            act(() =>
              trpc.catalog.updateFolder.mutate({
                folderId: dialog.folder.id,
                name,
              }),
            )
          }
        />
      ) : null}
      {dialog?.kind === "delete-folder" ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`Delete the folder “${{ name: dialog.folder.name }}”?`}
          description={t`Its tables stay in the base, back at the root. The folder itself is removed.`}
          confirmLabel={t`Delete`}
          onConfirm={() =>
            act(() =>
              trpc.catalog.deleteFolder.mutate({
                folderId: dialog.folder.id,
              }),
            )
          }
        />
      ) : null}
      {dialog?.kind === "create-table" ? (
        <NewTableDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t`New table in ${{ name: dialog.base.name }}`}
          onCreate={async ({ name, columns }) => {
            let created: { id: string } | undefined;
            await act(async () => {
              created = await trpc.catalog.createTable.mutate({
                baseId: dialog.base.id,
                name,
                columns,
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
          description={t`The table, its views, and the links to it go to the base's trash for ${{ days }} days.`}
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
