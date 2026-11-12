import {
  applyViewConfigPatch,
  MAX_VIEW_GROUPS,
  MAX_VIEW_SORTS,
  type FilterGroup,
} from "@anygriddb/core";
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Spinner,
  Tooltip,
} from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readKey, saveQueue, withoutSaved } from "./view-patch";
import { Database } from "lucide-react";
import { toast } from "sonner";
import { toWriteValue } from "../../lib/format";
import { ENGINE_NAMES } from "../../lib/limits";
import { useLocale } from "../../lib/i18n";
import { downloadJobFile, useTrackJob } from "../../lib/jobs";
import { useTrashActions, useTrashDays } from "../../lib/trash";
import { useChannel, usePresence } from "../../lib/realtime";
import { useCatalog, useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import {
  canManage,
  canWrite,
  type CatalogColumn,
  type Collaborator,
  type RowItem,
  type ViewConfig,
  type ViewItem,
} from "../../lib/types";
import { FieldEditor, type FieldEditorTarget } from "../fields/field-editor";
import { isLinkField } from "../fields/field-meta";
import { isEditableColumn } from "../grid/grid-clipboard";
import { nextFrozenColumns } from "../grid/margin-column";
import { GridView } from "../grid/grid-view";
import { useRows } from "../grid/use-rows";
import { useUndo } from "../grid/use-undo";
import { tableTakesUndo, undoShortcut } from "../../lib/keyboard-undo";
import { RecordPanel } from "../record/record-panel";
import { ConfirmDialog, PromptDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { CalendarView } from "../views/calendar-view";
import { FormView } from "../views/form-view";
import { GalleryView } from "../views/gallery-view";
import { KanbanView } from "../views/kanban-view";
import { MapView } from "../views/map-view";
import { placeColumns, placeFilter } from "../views/map-places";
import { TimelineView } from "../views/timeline-view";
import { AutomationsDialog } from "./automations-dialog";
import { DEFAULT_FROZEN, orderColumns, visibleColumns } from "./column-layout";
import { ImportDialog } from "./import-dialog";
import { newCondition } from "./filter-builder";
import { resolveRowTint } from "./row-tint";
import { upsertFirstLevel } from "./view-levels";
import {
  TableContext,
  type CellValue,
  type TableContextValue,
} from "./table-context";
import { ViewTabs } from "./view-tabs";
import { ViewToolbar, type ViewPatch } from "./view-toolbar";
import { useLingui } from "@lingui/react/macro";
import { plural } from "@lingui/core/macro";
import { useErrorText } from "../../lib/errors";
import { RowsError } from "../grid/rows-error";
import { NewRowDialog } from "./new-row-dialog";
import {
  calendarFilter,
  calendarStart,
  thisMonth,
} from "../views/calendar-view";

function canEditView(
  view: ViewItem | undefined,
  role: string | null,
  personalOwner: boolean,
): boolean {
  if (!view) return false;
  if (view.personal) return personalOwner;
  if (view.locked) return role === "owner";
  return role === "owner" || role === "editor";
}

/** Values a new row takes so it stays visible in a filtered view. */
function prefillFromFilter(
  filter: FilterGroup | undefined,
  columns: readonly CatalogColumn[],
): Record<string, CellValue> {
  if (!filter || filter.conjunction !== "and") return {};
  const values: Record<string, CellValue> = {};
  for (const node of filter.conditions) {
    if ("conjunction" in node) continue;
    const column = columns.find((item) => item.name === node.column);
    if (!column || !isEditableColumn(column)) continue;
    if (
      node.op === "is" &&
      (typeof node.value === "string" ||
        typeof node.value === "number" ||
        typeof node.value === "boolean")
    ) {
      values[column.name] = node.value;
    }
    if (
      node.op === "has_any_of" &&
      Array.isArray(node.value) &&
      column.fieldType === "multi_select"
    ) {
      values[column.name] = node.value.slice(0, 1);
    }
  }
  return values;
}

export function TableWorkspace({
  baseId,
  tableId,
  viewId,
  rowId,
}: {
  baseId: string;
  tableId: string;
  viewId?: string;
  /** A record to open in the side panel on arrival. */
  rowId?: string;
}) {
  const { t } = useLingui();
  const days = useTrashDays();
  const errorText = useErrorText();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const session = useSession();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === baseId);
  const table = base?.tables.find((item) => item.id === tableId);
  const role = table?.role ?? base?.role ?? null;
  const views = useQuery(api.catalog.views.queryOptions({ tableId }));
  const jobList = useQuery(api.jobs.list.queryOptions({ limit: 20 }));
  const trackJob = useTrackJob();
  const { trashed } = useTrashActions();
  const collaborators = useQuery(
    api.catalog.collaborators.queryOptions({ baseId }),
  );
  const viewList = useMemo(() => views.data?.views ?? [], [views.data]);
  const activeView = viewList.find((view) => view.id === viewId) ?? viewList[0];

  // The home lists the tables a person opened last; a failure there
  // changes nothing on this page.
  const openedId = table?.id;
  useEffect(() => {
    if (!openedId) return;
    void trpc.shortcuts.touchTable
      .mutate({ tableId: openedId })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: api.shortcuts.list.queryKey(),
        }),
      )
      .catch(() => undefined);
  }, [openedId, api, queryClient]);

  useEffect(() => {
    if (!viewId && activeView)
      void navigate({
        to: "/b/$baseId/t/$tableId/{-$viewId}",
        params: { baseId: baseId, tableId: tableId, viewId: activeView.id },
        replace: true,
      });
  }, [viewId, activeView, navigate, baseId, tableId]);

  // Unsaved changes to the view shown; another view starts clean.
  const [localPatch, setLocalPatch] = useState<ViewPatch>({});
  const [patchedView, setPatchedView] = useState(activeView?.id);
  if (patchedView !== activeView?.id) {
    setPatchedView(activeView?.id);
    setLocalPatch({});
  }
  const config: ViewConfig = useMemo(
    () =>
      applyViewConfigPatch(
        (activeView?.config ?? {}) as never,
        localPatch as never,
      ),
    [activeView?.config, localPatch],
  );
  const editableView = canEditView(activeView, role, true);
  // A client's table is read where it lives, and written only as an
  // administrator enabled it: editing, adding, and deleting apart.
  const external = table?.external ?? null;
  // Fields AnyGridDB added to a client's table are edited even when the
  // client's own fields are read-only (ADR 0032); each field says which.
  const hasSide = table?.columns.some((column) => column.side) ?? false;
  const writable =
    canWrite(role) && (!external || external.writes.update || hasSide);
  const canAdd = canWrite(role) && (!external || external.writes.insert);
  const canDelete = canWrite(role) && (!external || external.writes.delete);

  // A view's saves go one after another, and a setting is shown as kept
  // locally until its own save is stored: a quicker second change of the
  // same setting is neither undone nor saved first.
  const [queueSave] = useState(saveQueue);
  const patchView = useCallback(
    async (patch: ViewPatch) => {
      setLocalPatch((current) => ({ ...current, ...patch }));
      if (!activeView || !editableView) return;
      const viewId = activeView.id;
      await queueSave(async () => {
        try {
          await trpc.catalog.updateView.mutate({ viewId, patch });
          await queryClient.invalidateQueries({
            queryKey: api.catalog.views.queryKey({ tableId }),
          });
          setLocalPatch((current) => withoutSaved(current, patch));
        } catch (cause) {
          toast.error(errorText(cause));
        }
      });
    },
    [activeView, editableView, queryClient, api, tableId, errorText, queueSave],
  );

  const [search, setSearch] = useState("");
  // When the last write reached the database: the toolbar says so.
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const viewType = activeView?.viewType ?? "grid";
  const isGrid = viewType === "grid";
  const allColumns = useMemo(() => table?.columns ?? [], [table]);
  const ordered = useMemo(
    () => orderColumns(allColumns, config.fieldOrder),
    [allColumns, config.fieldOrder],
  );
  const hidden = useMemo(
    () => new Set(config.hiddenFields ?? []),
    [config.hiddenFields],
  );
  const visible = useMemo(
    () => visibleColumns(ordered, config.hiddenFields),
    [ordered, config.hiddenFields],
  );

  const groupBy = isGrid ? (config.groupBy ?? []) : [];
  const tintContext = useMemo(
    () => ({
      kinds: new Map(visible.map((column) => [column.name, column.kind])),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      me: session.data?.id,
    }),
    [visible, session.data?.id],
  );
  // A calendar reads the rows of the six weeks it shows, not a first page.
  const [calendarMonth, setCalendarMonth] = useState(thisMonth);
  const calendarField =
    viewType === "calendar" ? calendarStart(ordered, config) : undefined;
  // A map reads only the rows that have a place.
  const place = viewType === "map" ? placeColumns(config, ordered) : undefined;
  const latitude = place?.latitude;
  const longitude = place?.longitude;
  const scope = useMemo(
    () =>
      calendarField
        ? calendarFilter(calendarField, calendarMonth)
        : latitude && longitude
          ? placeFilter(latitude, longitude)
          : undefined,
    [calendarField, calendarMonth, latitude, longitude],
  );
  const askedQuery = useMemo(() => {
    const local =
      localPatch.filter !== undefined ||
      localPatch.sort !== undefined ||
      localPatch.groupBy !== undefined ||
      localPatch.filtersDisabled !== undefined;
    const own = config.filtersDisabled ? undefined : config.filter;
    // The server ANDs a filter it is given with the view's own.
    const filter = local
      ? own && scope
        ? { conjunction: "and" as const, conditions: [own, scope] }
        : (own ?? scope)
      : scope;
    return {
      viewId: activeView?.id,
      search: search || undefined,
      ...(local
        ? {
            ignoreViewFilter: true,
            sort: config.sort,
            groupBy: config.groupBy,
          }
        : {}),
      ...(filter ? { filter } : {}),
    };
  }, [activeView?.id, search, localPatch, config, scope]);
  // A setting is read with its value kept locally, then saved: the rows
  // read then stay, and the view keeps its place, as long as what the
  // read asks for is the same.
  const asked = readKey({
    viewId: activeView?.id,
    search,
    filter: config.filtersDisabled ? undefined : config.filter,
    sort: config.sort,
    groupBy: config.groupBy,
    scope,
  });
  const [kept, setKept] = useState({ key: asked, query: askedQuery });
  if (kept.key !== asked) setKept({ key: asked, query: askedQuery });
  const rowsQuery = kept.key === asked ? kept.query : askedQuery;
  const rows = useRows(
    tableId,
    rowsQuery,
    isGrid
      ? groupBy.length > 0
        ? "grouped"
        : "pages"
      : viewType === "gallery"
        ? "pages"
        : "onePage",
  );
  // A kanban and a calendar show a page of rows; their columns and days
  // count every row, as the database groups them.
  const stackName =
    viewType === "kanban"
      ? typeof config.stackColumn === "string"
        ? config.stackColumn
        : ordered.find((column) => column.fieldType === "single_select")?.name
      : calendarField?.kind === "date"
        ? calendarField.name
        : undefined;
  const stackCounts = useQuery({
    ...api.rows.read.queryOptions({
      ...rowsQuery,
      tableId,
      offset: 0,
      limit: 1,
      withTotal: false,
      groupBy: [{ column: stackName ?? "", direction: "asc" }],
    }),
    enabled: stackName !== undefined,
  });
  const counts = useMemo(() => {
    if (!stackName || !stackCounts.data) return undefined;
    return new Map(
      stackCounts.data.groups
        .filter((group) => group.depth === 1)
        .map((group) => [
          typeof group.keys[0] === "string" ? group.keys[0] : "",
          group.count,
        ]),
    );
  }, [stackName, stackCounts.data]);
  // A field added, changed, or removed changes what the rows hold: a new
  // formula's values, a converted field's. Read them again.
  useChannel(baseId, {
    message: (message) => {
      if (message.type === "catalog") rows.refresh();
    },
    resync: () => {
      rows.refresh();
    },
  });

  const people = useMemo(
    () =>
      new Map<string, Collaborator>(
        (collaborators.data?.users ?? []).map((person) => [person.id, person]),
      ),
    [collaborators.data],
  );
  const rowsById = useMemo(
    () => new Map(rows.loadedRows().map((row) => [row.id, row])),
    [rows],
  );

  const [activeCell, setActiveCell] = useState<{
    rowId?: string;
    column?: string;
  }>({});
  const presence = usePresence(tableId, session.data?.id, {
    viewId: activeView?.id,
    ...activeCell,
  });
  const onActiveCell = useCallback(
    (rowId: string | undefined, column: string | undefined) =>
      setActiveCell({ rowId, column }),
    [],
  );

  const aggregations = (config.aggregations ?? {}) as Record<string, string>;
  const items = Object.entries(aggregations).flatMap(([column, fn]) =>
    allColumns.some((item) => item.name === column)
      ? [{ column, fn: fn as never }]
      : [],
  );
  const aggregates = useQuery({
    ...api.rows.aggregate.queryOptions({
      tableId,
      viewId: activeView?.id,
      search: search || undefined,
      items,
    }),
    enabled: isGrid && items.length > 0 && Boolean(activeView),
  });
  const refetchAggregates = aggregates.refetch;
  useEffect(() => {
    if (items.length > 0) void refetchAggregates();
  }, [rows.version, items.length, refetchAggregates]);

  const undo = useUndo();
  const [reasonAsk, setReasonAsk] = useState<{
    resolve: (reason: string | undefined) => void;
  } | null>(null);
  const askReason = useCallback(
    (touched: readonly string[]) =>
      new Promise<string | undefined>((resolve) => {
        if (
          !allColumns.some(
            (column) => column.requireReason && touched.includes(column.name),
          )
        ) {
          resolve(undefined);
          return;
        }
        setReasonAsk({ resolve });
      }),
    [allColumns],
  );

  const updateCells = useCallback<TableContextValue["updateCells"]>(
    // Named, so its undo entries can call it again.
    async function update(updates, options) {
      if (updates.length === 0) return;
      const byName = new Map(allColumns.map((column) => [column.name, column]));
      updates = updates.map((update) => ({
        rowId: update.rowId,
        values: Object.fromEntries(
          Object.entries(update.values).map(([key, value]) => [
            key,
            toWriteValue(byName.get(key)?.fieldType ?? "text", value),
          ]),
        ),
      }));
      const touched = [
        ...new Set(updates.flatMap((update) => Object.keys(update.values))),
      ];
      const reason = await askReason(touched);
      if (
        reason === undefined &&
        allColumns.some(
          (column) => column.requireReason && touched.includes(column.name),
        )
      )
        return;
      const previous = updates.map((update) => {
        const row = rowsById.get(update.rowId);
        return {
          rowId: update.rowId,
          values: Object.fromEntries(
            Object.keys(update.values).map((key) => [
              key,
              (row?.[key as keyof RowItem] ?? null) as CellValue,
            ]),
          ),
        };
      });
      for (const update of updates)
        rows.patchLocal(update.rowId, update.values);
      // Until the save answers, a read made elsewhere may still hold the
      // rows as they were: it must not put that back under an open editor.
      const release = rows.holdRows(updates.map((update) => update.rowId));
      // Kept as soon as it is sent: an undo right away waits for the save.
      let settle: (applied: boolean) => void = () => undefined;
      if (options?.undoable !== false) {
        undo.push({
          label: t`Edit`,
          undo: () => update(previous, { undoable: false }),
          redo: () => update(updates, { undoable: false }),
          settled: new Promise<boolean>((resolve) => {
            settle = resolve;
          }),
        });
      }
      setSaveStatus("saving");
      try {
        // A client's table compares what the person saw with what its
        // row holds now, and refuses the change if it moved (ADR 0006).
        const sent = updates.map((update, index) =>
          external
            ? { ...update, expected: previous[index]?.values ?? {} }
            : update,
        );
        for (let index = 0; index < sent.length; index += 500) {
          await trpc.rows.updateMany.mutate({
            tableId,
            updates: sent.slice(index, index + 500),
            reason,
          });
        }
        release();
        void rows.refetchIds(updates.map((update) => update.rowId));
        setSavedAt(new Date());
        setSaveStatus("saved");
        settle(true);
      } catch (cause) {
        for (const update of previous)
          rows.patchLocal(update.rowId, update.values);
        release();
        // What the rows hold now, which may not be what was shown.
        void rows.refetchIds(updates.map((update) => update.rowId));
        setSaveStatus("error");
        toast.error(errorText(cause));
        settle(false);
      }
    },
    [
      askReason,
      allColumns,
      rowsById,
      rows,
      tableId,
      t,
      undo,
      errorText,
      external,
    ],
  );

  const setLinks = useCallback<TableContextValue["setLinks"]>(
    // Named, so its undo entries can call it again.
    async function link(rowId, column, targetIds, options) {
      const reason = await askReason([column]);
      if (
        reason === undefined &&
        allColumns.some((item) => item.name === column && item.requireReason)
      )
        return;
      const held = rowsById.get(rowId)?.[column as keyof RowItem];
      const previous = Array.isArray(held)
        ? held.flatMap((item: unknown) =>
            item && typeof item === "object" && "id" in item
              ? [String(item.id)]
              : [],
          )
        : [];
      let settle: (applied: boolean) => void = () => undefined;
      if (options?.undoable !== false) {
        undo.push({
          label: t`Edit`,
          undo: () => link(rowId, column, previous, { undoable: false }),
          redo: () => link(rowId, column, targetIds, { undoable: false }),
          settled: new Promise<boolean>((resolve) => {
            settle = resolve;
          }),
        });
      }
      try {
        await trpc.rows.setLinks.mutate({
          tableId,
          rowId,
          column,
          targetIds,
          reason,
        });
        await rows.refetchIds([rowId]);
        settle(true);
      } catch (cause) {
        toast.error(errorText(cause));
        settle(false);
      }
    },
    [tableId, rows, rowsById, allColumns, askReason, errorText, undo, t],
  );

  // Ctrl Z and Ctrl Y (or Ctrl Shift Z) undo and redo the table's changes
  // wherever the focus is on its page, a cell's list panel included; text
  // being typed and dialogs keep their own.
  const { undo: undoLast, redo: redoLast } = undo;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = undoShortcut(event);
      // A list panel copies each key to its active option (untrusted).
      if (!action || !event.isTrusted || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!tableTakesUndo(target)) return;
      event.preventDefault();
      void (action === "undo" ? undoLast() : redoLast());
    };
    // Captured: a list panel stops the keys it gets from bubbling.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [undoLast, redoLast]);

  const insertRows = useCallback(
    async (
      list: Array<Record<string, CellValue>>,
      track = true,
    ): Promise<string[]> => {
      try {
        const reason = await askReason([
          ...new Set(list.flatMap((values) => Object.keys(values))),
        ]);
        const created = await trpc.rows.insertMany.mutate({
          tableId,
          rows: list,
          reason,
        });
        rows.refresh();
        setSavedAt(new Date());
        setSaveStatus("saved");
        // A client's row has no trash to come back from: no undo there.
        if (track && !external) {
          undo.push({
            label: t`Insert`,
            undo: async () => {
              await trpc.rows.deleteMany.mutate({
                tableId,
                rowIds: created.ids,
              });
              rows.refresh();
            },
            redo: async () => {
              await trpc.rows.restore.mutate({ tableId, rowIds: created.ids });
              rows.refresh();
            },
          });
        }
        return created.ids;
      } catch (cause) {
        setSaveStatus("error");
        toast.error(errorText(cause));
        return [];
      }
    },
    [tableId, rows, undo, t, askReason, errorText, external],
  );

  const deleteRows = useCallback(
    async (rowIds: string[]) => {
      if (rowIds.length === 0) return;
      try {
        const reason = await askReason(
          allColumns
            .filter((column) => column.requireReason)
            .map((column) => column.name),
        );
        await trpc.rows.deleteMany.mutate({ tableId, rowIds, reason });
        rows.refresh();
        setSavedAt(new Date());
        setSaveStatus("saved");
        if (external) {
          // Deleted in the client's database: nothing to restore from.
          toast.success(
            plural(rowIds.length, {
              one: `# row deleted from the client's database`,
              other: `# rows deleted from the client's database`,
            }),
          );
          return;
        }
        toast.success(t`${{ count: rowIds.length }} rows deleted`, {
          action: {
            label: t`Cancel`,
            onClick: () =>
              void trpc.rows.restore
                .mutate({ tableId, rowIds })
                .then(() => rows.refresh()),
          },
        });
        undo.push({
          label: t`Delete`,
          undo: async () => {
            await trpc.rows.restore.mutate({ tableId, rowIds });
            rows.refresh();
          },
          redo: async () => {
            await trpc.rows.deleteMany.mutate({ tableId, rowIds });
            rows.refresh();
          },
        });
      } catch (cause) {
        setSaveStatus("error");
        toast.error(errorText(cause));
      }
    },
    [tableId, rows, undo, t, askReason, allColumns, errorText, external],
  );

  const duplicateRows = useCallback(
    async (rowIds: string[]) => {
      const list = rowIds.flatMap((id) => {
        const row = rowsById.get(id);
        if (!row) return [];
        return [
          Object.fromEntries(
            allColumns
              .filter((column) => isEditableColumn(column))
              .map((column) => [
                column.name,
                (row[column.name as keyof RowItem] ?? null) as CellValue,
              ]),
          ),
        ];
      });
      if (list.length > 0) await insertRows(list);
    },
    [rowsById, allColumns, insertRows],
  );

  const addRow = useCallback(
    async (
      values: Record<string, unknown> = {},
    ): Promise<string | undefined> => {
      const ids = await insertRows([
        {
          ...prefillFromFilter(config.filter, allColumns),
          ...(values as Record<string, CellValue>),
        },
      ]);
      return ids[0];
    },
    [insertRows, config.filter, allColumns],
  );

  const [recordId, setRecordId] = useState<string | null>(rowId ?? null);
  const openRecord = useCallback((rowId: string) => setRecordId(rowId), []);
  // A client's table checks a new row as a whole: it is filled first. A
  // row of AnyGridDB's own starts empty, in its record panel.
  const [newRowOpen, setNewRowOpen] = useState(false);
  const newRow = useCallback(() => {
    if (external) {
      setNewRowOpen(true);
      return;
    }
    void addRow().then((id) => {
      if (id) setRecordId(id);
    });
  }, [external, addRow]);
  const recordQuery = useQuery({
    ...api.rows.get.queryOptions({
      tableId,
      rowIds: recordId ? [recordId] : ["00000000-0000-4000-8000-000000000000"],
    }),
    enabled: Boolean(recordId) && !rowsById.has(recordId ?? ""),
  });
  const recordRow = recordId
    ? (rowsById.get(recordId) ?? recordQuery.data?.rows[0])
    : undefined;
  const loadedOrder = rows.loadedRows();
  const recordIndex = recordRow
    ? loadedOrder.findIndex((row) => row.id === recordRow.id)
    : -1;

  const [fieldEditor, setFieldEditor] = useState<FieldEditorTarget | null>(
    null,
  );
  const [deleteColumn, setDeleteColumn] = useState<CatalogColumn | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);

  const invalidateCatalog = () =>
    queryClient.invalidateQueries({ queryKey: api.catalog.list.queryKey() });

  function onHeaderAction(action: string, column: CatalogColumn) {
    switch (action) {
      case "sort-asc":
      case "sort-desc":
        void patchView({
          sort: upsertFirstLevel(
            config.sort ?? [],
            {
              column: column.name,
              direction: action === "sort-asc" ? "asc" : "desc",
            },
            MAX_VIEW_SORTS,
          ),
        });
        return;
      case "group":
        void patchView({
          groupBy: upsertFirstLevel(
            config.groupBy ?? [],
            { column: column.name, direction: "asc" },
            MAX_VIEW_GROUPS,
          ),
        });
        return;
      case "hide":
        void patchView({ hiddenFields: [...hidden, column.name] });
        return;
      case "freeze": {
        const index = visible.indexOf(column);
        if (index < 0) return;
        void patchView({
          frozenColumns: nextFrozenColumns(
            config.frozenColumns ?? DEFAULT_FROZEN,
            index,
          ),
        });
        return;
      }
      case "filter": {
        const current = config.filter ?? {
          conjunction: "and" as const,
          conditions: [],
        };
        void patchView({
          filter: {
            ...current,
            conditions: [...current.conditions, newCondition(column)],
          },
        }).then(() => setFilterOpen(true));
        return;
      }
      case "insert-left":
      case "insert-right":
        setFieldEditor({
          mode: "create",
          position: column.position + (action === "insert-right" ? 1 : 0),
        });
        return;
      case "primary":
        void trpc.catalog.setPrimaryColumn
          .mutate({ tableId, name: column.name })
          .then(invalidateCatalog)
          .catch((cause: unknown) => toast.error(errorText(cause)));
        return;
      case "duplicate":
        void trpc.catalog.duplicateColumn
          .mutate({ tableId, name: column.name })
          .then(async (created) => {
            await invalidateCatalog();
            rows.refresh();
            if (created.skipped > 0) {
              toast.warning(
                t`${{ count: created.skipped }} locked rows were not copied`,
              );
            }
          })
          .catch((cause: unknown) => toast.error(errorText(cause)));
        return;
      case "delete":
        setDeleteColumn(column);
        return;
    }
  }

  async function exportView(format: "csv" | "json" | "xlsx") {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (jobList.data?.exportFiles) {
      // Large views take a while: the file is built by a job, then downloaded.
      let jobId: string;
      try {
        ({ jobId } = await trpc.jobs.startExport.mutate({
          tableId,
          viewId: activeView?.id,
          format,
          search: search || undefined,
          timeZone,
        }));
      } catch (cause) {
        toast.error(errorText(cause));
        return;
      }
      const job = await trackJob(jobId, {
        label: t`Exporting ${{ table: table?.name ?? "" }}…`,
        onDone: () => ({ message: t`Export ready` }),
      });
      if (job.status === "done" && job.download) downloadJobFile(job.id);
      return;
    }
    const query = new URLSearchParams({ format });
    if (activeView?.id) query.set("viewId", activeView.id);
    if (search) query.set("search", search);
    query.set("timeZone", timeZone);
    // The API answers with an attachment, so the page stays where it is.
    const link = document.createElement("a");
    link.href = `/api/export/${tableId}?${query.toString()}`;
    link.rel = "noopener";
    link.click();
  }

  if (!catalog.data || !views.data) {
    const failed = catalog.error ?? views.error;
    if (failed) {
      return (
        <LoadFailed
          error={failed}
          onRetry={() => {
            void catalog.refetch();
            void views.refetch();
          }}
        />
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!base || !table) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`This table does not exist or is not shared with you.`}
      </p>
    );
  }

  const contextValue: TableContextValue = {
    baseId,
    table,
    tables: base.tables,
    columns: allColumns,
    role,
    view: activeView ?? null,
    people,
    locale,
    search,
    updateCells,
    setLinks,
    openRecord,
    rowsById,
    saveStatus,
  };

  const viewProps = {
    rows: loadedOrder,
    total: rows.total,
    rowAt: rows.rowAt,
    ensure: rows.ensure,
    columns: visible,
    allColumns: ordered,
    config: config as Record<string, unknown>,
    canEdit: writable,
    onPatch: (patch: ViewPatch) => void patchView(patch),
    onCreate: (values: Record<string, unknown>) => addRow(values),
    tintOf: (row: RowItem) =>
      resolveRowTint(row, visible, config.color, tintContext),
    ...(counts ? { counts } : {}),
  };

  return (
    <TableContext.Provider value={contextValue}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* One line: the table, where it lives, its views, who is here. */}
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card pr-2 pl-4">
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <h1 className="max-w-64 truncate text-base font-semibold">
              {table.name}
            </h1>
            {table.external ? (
              // A client's table (ADR 0006): its name in the database, always in view.
              <Tooltip
                content={
                  (ENGINE_NAMES as Record<string, string>)[
                    table.external.engine
                  ] ?? table.external.engine
                }
              >
                <span
                  tabIndex={0}
                  className="inline-flex h-[22px] max-w-56 items-center gap-1.5 rounded-md border border-border bg-background px-2 font-mono text-xs text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Database className="h-3 w-3 shrink-0" aria-hidden />
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
            views={viewList}
            activeId={activeView?.id}
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
        {table.external?.synced ? (
          // Read from a copy (ADR 0034): say how fresh it is.
          <p
            role="note"
            className="border-b border-border bg-head px-4 py-1 text-xs text-muted-foreground"
          >
            {table.external.synced.at
              ? t`Copy of the client's database from ${{
                  date: new Date(table.external.synced.at).toLocaleString(
                    locale === "fr" ? "fr-FR" : "en-GB",
                  ),
                }}, refreshed every ${{ minutes: table.external.synced.intervalMinutes }} min: read-only`
              : t`Copy in preparation: the table is read live until then`}
          </p>
        ) : null}
        <ViewToolbar
          config={config}
          columns={visible}
          allColumns={ordered}
          people={people}
          search={search}
          onSearch={setSearch}
          onPatch={(patch) => void patchView(patch)}
          // Imports, the row trash, and automations stay with AnyGridDB's
          // own tables for now.
          canEdit={writable && !external}
          canUndo={undo.canUndo}
          canRedo={undo.canRedo}
          onUndo={() => void undo.undo()}
          onRedo={() => void undo.redo()}
          onExport={exportView}
          onImport={() => setImportOpen(true)}
          onTrash={() => setTrashOpen(true)}
          onAutomations={
            canManage(role) ? () => setAutomationsOpen(true) : undefined
          }
          onNewRow={canAdd ? newRow : undefined}
          gridOnly={isGrid}
          filterOpen={filterOpen}
          onFilterOpen={setFilterOpen}
          savedAt={savedAt}
          saveStatus={saveStatus}
        />
        {typeof config.description === "string" && config.description ? (
          <p
            className="border-b border-border px-4 py-1.5 text-sm whitespace-pre-line text-muted-foreground"
            aria-label={t`View description`}
          >
            {config.description}
          </p>
        ) : null}
        {!editableView && activeView ? (
          <p className="border-b border-border bg-accent/40 px-4 py-1 text-xs text-muted-foreground">
            {activeView.locked
              ? t`Locked view: your settings stay local.`
              : t`Your view settings stay local.`}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {isGrid ? (
              <GridView
                rows={rows}
                columns={visible}
                widths={config.columnWidths ?? {}}
                frozen={config.frozenColumns ?? DEFAULT_FROZEN}
                rowHeight={config.rowHeight ?? "short"}
                groupBy={groupBy}
                tintOf={(row) =>
                  resolveRowTint(row, visible, config.color, tintContext)
                }
                canEdit={writable}
                canAdd={canAdd}
                canDelete={canDelete}
                canManage={canManage(role)}
                aggregations={aggregations}
                aggregateValues={aggregates.data?.values}
                presence={presence.filter(
                  (peer) => peer.viewId === activeView?.id,
                )}
                onActiveCell={onActiveCell}
                onAddRow={async () => {
                  if (external) {
                    setNewRowOpen(true);
                    return;
                  }
                  // The new row appears in the grid: that is the confirmation.
                  await addRow();
                }}
                onInsertRows={async (list) => {
                  await insertRows(list);
                }}
                onDeleteRows={deleteRows}
                onDuplicateRows={duplicateRows}
                onResize={(column, width) =>
                  void patchView({
                    columnWidths: {
                      ...(config.columnWidths ?? {}),
                      [column]: width,
                    },
                  })
                }
                onReorder={(from, to) => {
                  const order = ordered.map((column) => column.name);
                  const fromIndex = order.indexOf(from);
                  const toIndex = order.indexOf(to);
                  if (fromIndex < 0 || toIndex < 0) return;
                  order.splice(toIndex, 0, ...order.splice(fromIndex, 1));
                  void patchView({ fieldOrder: order });
                }}
                onAggregate={(column, fn) => {
                  const next = { ...aggregations };
                  if (fn) next[column] = fn;
                  else Reflect.deleteProperty(next, column);
                  void patchView({
                    aggregations:
                      Object.keys(next).length > 0 ? (next as never) : null,
                  });
                }}
                onAddField={(position) =>
                  setFieldEditor({ mode: "create", position })
                }
                onEditField={(column) =>
                  setFieldEditor({ mode: "edit", column })
                }
                onHeaderAction={(action, column) =>
                  onHeaderAction(action, column)
                }
              />
            ) : rows.error ? (
              <RowsError
                error={rows.error}
                onRetry={rows.refresh}
                tableId={table.external ? table.id : undefined}
              />
            ) : rows.loading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : viewType === "kanban" ? (
              <KanbanView {...viewProps} />
            ) : viewType === "gallery" ? (
              <GalleryView {...viewProps} />
            ) : viewType === "calendar" ? (
              <CalendarView
                {...viewProps}
                month={calendarMonth}
                onMonth={setCalendarMonth}
                {...(activeView ? { viewId: activeView.id } : {})}
              />
            ) : viewType === "timeline" ? (
              <TimelineView {...viewProps} />
            ) : viewType === "form" ? (
              <FormView {...viewProps} canEdit={canAdd} />
            ) : (
              <MapView {...viewProps} />
            )}
          </div>
          {recordRow ? (
            <RecordPanel
              row={recordRow}
              columns={visible}
              onClose={() => setRecordId(null)}
              onPrevious={
                recordIndex > 0
                  ? () => setRecordId(loadedOrder[recordIndex - 1]?.id ?? null)
                  : undefined
              }
              onNext={
                recordIndex >= 0 && recordIndex < loadedOrder.length - 1
                  ? () => setRecordId(loadedOrder[recordIndex + 1]?.id ?? null)
                  : undefined
              }
              onDuplicate={
                canAdd && rowsById.has(recordRow.id)
                  ? () => void duplicateRows([recordRow.id])
                  : undefined
              }
              onDelete={
                canDelete
                  ? () => {
                      setRecordId(null);
                      void deleteRows([recordRow.id]);
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </div>

      {fieldEditor ? (
        <FieldEditor
          open
          onOpenChange={(open) => !open && setFieldEditor(null)}
          target={fieldEditor}
          table={table}
          tables={base.tables}
        />
      ) : null}
      {deleteColumn ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setDeleteColumn(null)}
          title={t`Delete the field “${{ name: deleteColumn.label }}”?`}
          description={
            isLinkField(deleteColumn.fieldType)
              ? t`The field, and its inverse field if any, go to the base's trash for ${{ days }} days with their links.`
              : t`The field goes to the base's trash for ${{ days }} days with its values.`
          }
          confirmLabel={t`Delete`}
          onConfirm={async () => {
            const column = deleteColumn;
            try {
              await trpc.catalog.deleteColumn.mutate({
                tableId,
                name: column.name,
              });
              await invalidateCatalog();
              rows.refresh();
              trashed(t`Field moved to the trash`, "column", column.id);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          }}
        />
      ) : null}
      {reasonAsk ? (
        <PromptDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              reasonAsk.resolve(undefined);
              setReasonAsk(null);
            }
          }}
          title={t`Reason for the change`}
          label={t`This field needs a reason, kept in the audit trail.`}
          submitLabel={t`Confirm`}
          onSubmit={(reason) => {
            reasonAsk.resolve(reason);
            setReasonAsk(null);
          }}
        />
      ) : null}
      {automationsOpen ? (
        <AutomationsDialog onClose={() => setAutomationsOpen(false)} />
      ) : null}
      {importOpen ? (
        <ImportDialog
          open
          onOpenChange={setImportOpen}
          target={{
            kind: "existing",
            tableId,
            columns: allColumns,
            canManage: canManage(role),
            external: table.external !== null,
          }}
          onDone={() => {
            void invalidateCatalog();
            rows.refresh();
          }}
        />
      ) : null}
      {trashOpen ? (
        <TrashDialog
          tableId={tableId}
          onClose={() => setTrashOpen(false)}
          onRestored={() => rows.refresh()}
        />
      ) : null}
      {newRowOpen ? (
        <NewRowDialog
          open
          columns={ordered}
          onClose={() => setNewRowOpen(false)}
          onCreate={(values) => addRow(values)}
        />
      ) : null}
    </TableContext.Provider>
  );
}

function TrashDialog({
  tableId,
  onClose,
  onRestored,
}: {
  tableId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const trash = useQuery(api.rows.trash.queryOptions({ tableId, limit: 100 }));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const busy = useRef(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t`Row trash`}
        description={t`Deleted rows come back as drafts, with their original number.`}
      >
        {trash.isLoading ? <Spinner /> : null}
        <ul className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto">
          {(trash.data?.rows ?? []).map((item) => (
            <li
              key={item.rowId}
              className="flex items-center gap-2 py-1.5 text-sm"
            >
              <Checkbox
                checked={picked.has(item.rowId)}
                onChange={(event) =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item.rowId);
                    else next.delete(item.rowId);
                    return next;
                  })
                }
              />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="text-xs text-muted-foreground">
                {item.deletedBy} · {new Date(item.deletedAt).toLocaleString()}
              </span>
            </li>
          ))}
          {trash.data?.rows.length === 0 ? (
            <li className="py-4 text-sm text-muted-foreground">
              {t`The trash is empty.`}
            </li>
          ) : null}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t`Close`}
          </Button>
          <Button
            disabled={picked.size === 0}
            onClick={async () => {
              if (busy.current) return;
              busy.current = true;
              try {
                await trpc.rows.restore.mutate({
                  tableId,
                  rowIds: [...picked],
                });
                toast.success(t`${{ count: picked.size }} rows restored`);
                setPicked(new Set());
                onRestored();
                await queryClient.invalidateQueries({
                  queryKey: api.rows.trash.queryKey({ tableId, limit: 100 }),
                });
              } catch (cause) {
                toast.error(errorText(cause));
              } finally {
                busy.current = false;
              }
            }}
          >
            {t`Restore`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
