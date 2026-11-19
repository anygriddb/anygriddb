import { isCopySourceEngine } from "@anygriddb/core";
import { Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useLocale } from "../../lib/i18n";
import { useNarrowScreen } from "../../lib/narrow-screen";
import { usePresence } from "../../lib/realtime";
import { useCatalog, useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import {
  canManage,
  canWrite,
  type CatalogColumn,
  type Collaborator,
  type RowItem,
} from "../../lib/types";
import { FieldEditor, type FieldEditorTarget } from "../fields/field-editor";
import { GridTips } from "../grid/grid-tips";
import { GridView } from "../grid/grid-view";
import { RowsError } from "../grid/rows-error";
import { RecordPanel } from "../record/record-panel";
import { LoadFailed } from "../shell/load-failed";
import { CalendarView } from "../views/calendar-view";
import { FormView } from "../views/form-view";
import { GalleryView } from "../views/gallery-view";
import { KanbanView } from "../views/kanban-view";
import { ListView } from "../views/list-view";
import { MapView } from "../views/map-view";
import { RowCards } from "../views/row-cards";
import { TimelineView } from "../views/timeline-view";
import { AutomationsDialog } from "./automations-dialog";
import { DEFAULT_FROZEN, orderColumns, visibleColumns } from "./column-layout";
import { DeleteFieldDialog } from "./delete-field-dialog";
import { EmptyTableHint } from "./empty-table-hint";
import { emptyTableHint } from "./empty-table-hint-model";
import { fieldMenuPatch } from "./field-menu";
import { ImportDialog } from "./import-dialog";
import { NewRowDialog } from "./new-row-dialog";
import { ReasonDialog } from "./reason-dialog";
import { RowTrashDialog } from "./row-trash-dialog";
import { resolveRowTint } from "./row-tint";
import { TableContext, type TableContextValue } from "./table-context";
import { CopyNote, TableHeader, ViewNotes } from "./table-header";
import { useAggregates } from "./use-aggregates";
import { useFieldChanges } from "./use-field-changes";
import { useNewRow } from "./use-new-row";
import { useReason } from "./use-reason";
import { useRecordPanel } from "./use-record-panel";
import { useRowWrites } from "./use-row-writes";
import { useUndoKeys } from "./use-undo-keys";
import { useViewExport } from "./use-view-export";
import { useViewRows } from "./use-view-rows";
import { useViewSettings } from "./use-view-settings";
import { ViewToolbar, type ViewPatch } from "./view-toolbar";

/** A table not read yet has no field: one list, the same every time. */
const NO_COLUMNS: readonly CatalogColumn[] = [];

/**
 * A table's page: its header, the toolbar of the view shown, the view
 * itself, the panel of an open row, and the dialogs they call. What each
 * part needs is read and written by a hook of its own; this component
 * gives them to each other.
 *
 * It holds no `useMemo` and no `useCallback`: the React Compiler keeps
 * what it computes from one render to the next, the value the rows and
 * the cells read from its context among them.
 */
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
  const collaborators = useQuery(
    api.catalog.collaborators.queryOptions({ baseId }),
  );
  const viewList = views.data?.views ?? [];
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

  // The view: its settings, its fields in its order, and its rows.
  const settings = useViewSettings({ tableId, view: activeView, role });
  const { config } = settings;
  const patchView = settings.patch;
  // What the person may do to its rows. A client's table is read where
  // it lives, and written only as an administrator enabled it: editing,
  // adding, and deleting apart.
  const external = table?.external ?? null;
  // Fields AnyGridDB added to a client's table are edited even when the
  // client's own fields are read-only (ADR 0032); each field says which.
  const hasSide = table?.columns.some((column) => column.side) ?? false;
  const writable =
    canWrite(role) && (!external || external.writes.update || hasSide);
  const canAdd = canWrite(role) && (!external || external.writes.insert);
  const canDelete = canWrite(role) && (!external || external.writes.delete);
  // AnyGridDB's own rows keep the order people give them, which a view
  // shows when it sorts nothing (ADR 0060); a client's keep its database's.
  const byHand =
    external === null && canWrite(role) && (config.sort?.length ?? 0) === 0;
  const [search, setSearch] = useState("");
  const viewType = activeView?.viewType ?? "grid";
  const isGrid = viewType === "grid";
  // A phone has no room for a grid's columns: its rows are cards.
  const narrow = useNarrowScreen();
  const allColumns = table?.columns ?? NO_COLUMNS;
  const ordered = orderColumns(allColumns, config.fieldOrder);
  const visible = visibleColumns(ordered, config.hiddenFields);
  const groupBy = isGrid ? (config.groupBy ?? []) : [];
  const tintContext = {
    kinds: new Map(visible.map((column) => [column.name, column.kind])),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    me: session.data?.id,
  };
  const read = useViewRows({
    baseId,
    tableId,
    view: activeView,
    config,
    local: settings.local,
    search,
    columns: ordered,
  });
  const { rows } = read;
  const people = new Map<string, Collaborator>(
    (collaborators.data?.users ?? []).map((person) => [person.id, person]),
  );
  const rowsById = new Map(rows.loadedRows().map((row) => [row.id, row]));
  const aggregates = useAggregates({
    tableId,
    viewId: activeView?.id,
    search,
    config,
    columns: allColumns,
    enabled: isGrid,
    version: rows.version,
  });

  // Who else is here, and on which cell.
  const [activeCell, setActiveCell] = useState<{
    rowId?: string;
    column?: string;
  }>({});
  const presence = usePresence(tableId, session.data?.id, {
    viewId: activeView?.id,
    ...activeCell,
  });
  const onActiveCell = (
    rowId: string | undefined,
    column: string | undefined,
  ) => setActiveCell({ rowId, column });

  // The changes the person makes.
  const reason = useReason(allColumns);
  const writes = useRowWrites({
    tableId,
    columns: allColumns,
    rows,
    rowsById,
    external: external !== null,
    stacked: read.layout === "stacks",
    byHand,
    filter: config.filter,
    reason,
  });
  const { addRow, deleteRows, duplicateRows, insertRows, moveRows } = writes;
  useUndoKeys(writes.undo, writes.redo);

  // The row open in the panel, and a row being added.
  const loaded = rows.loadedRows();
  const record = useRecordPanel({
    tableId,
    initial: rowId,
    rowsById,
    loaded,
  });
  // A client's table checks a new row as a whole, and a table with a
  // required field refuses an empty one: the row is filled first.
  const fillFirst =
    external !== null || allColumns.some((column) => column.required);
  const newRow = useNewRow({ fillFirst, addRow, openRecord: record.open });

  // What an empty grid says under its last line.
  const canImport = writable && external === null;
  const hint = emptyTableHint({
    total: rows.total,
    loading: rows.loading,
    grouped: groupBy.length > 0,
    searched: search.trim() !== "",
    filtered:
      !config.filtersDisabled && (config.filter?.conditions.length ?? 0) > 0,
    canAdd,
    canImport,
    copyPending:
      external?.synced != null &&
      external.synced.at === null &&
      isCopySourceEngine(external.engine),
  });

  // The dialogs the page opens.
  const [fieldEditor, setFieldEditor] = useState<FieldEditorTarget | null>(
    null,
  );
  const [deleteColumn, setDeleteColumn] = useState<CatalogColumn | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const fields = useFieldChanges({ tableId, refreshRows: rows.refresh });
  const exportView = useViewExport({
    tableId,
    tableName: table?.name ?? "",
    viewId: activeView?.id,
    search,
  });

  function onHeaderAction(action: string, column: CatalogColumn) {
    const patch = fieldMenuPatch(action, column, { config, visible });
    if (patch) {
      // A condition added to the filter opens ready to be filled.
      void patchView(patch).then(() => {
        if (action === "filter") setFilterOpen(true);
      });
      return;
    }
    switch (action) {
      case "insert-left":
      case "insert-right":
        setFieldEditor({
          mode: "create",
          position: column.position + (action === "insert-right" ? 1 : 0),
        });
        return;
      case "primary":
        fields.makePrimary(column);
        return;
      case "duplicate":
        fields.duplicate(column);
        return;
      case "delete":
        setDeleteColumn(column);
        return;
    }
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
    updateCells: (updates) => writes.updateCells(updates),
    setLinks: (row, column, targetIds) =>
      writes.setLinks(row, column, targetIds),
    openRecord: record.open,
    rowsById,
    saveStatus: writes.saveStatus,
  };

  const tintOf = (row: RowItem) =>
    resolveRowTint(row, visible, config.color, tintContext);
  const viewProps = {
    rows: loaded,
    total: rows.total,
    rowAt: rows.rowAt,
    ensure: rows.ensure,
    columns: visible,
    allColumns: ordered,
    config: config as Record<string, unknown>,
    canEdit: writable,
    onPatch: (patch: ViewPatch) => void patchView(patch),
    // A form fills its own fields; a card or a day added elsewhere opens
    // the new row with what it already knows.
    onCreate:
      viewType === "form"
        ? (values: Record<string, unknown>) => addRow(values)
        : newRow.addWith,
    tintOf,
    ...(byHand ? { onMoveRows: moveRows } : {}),
    groups: rows.groups,
    ...(read.counts ? { counts: read.counts } : {}),
    ...(canManage(role) && !external
      ? { onOpenFieldEditor: () => setFieldEditor({ mode: "create" }) }
      : {}),
  };
  const openRow = record.row;

  return (
    <TableContext.Provider value={contextValue}>
      <div className="flex min-h-0 flex-1 flex-col">
        <TableHeader
          baseId={baseId}
          table={table}
          views={viewList}
          activeId={activeView?.id}
          role={role}
          presence={presence}
        />
        {table.external ? (
          <CopyNote external={table.external} locale={locale} />
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
          canUndo={writes.canUndo}
          canRedo={writes.canRedo}
          onUndo={writes.undo}
          onRedo={writes.redo}
          onExport={exportView}
          onImport={() => setImportOpen(true)}
          onTrash={() => setTrashOpen(true)}
          onAutomations={
            canManage(role) ? () => setAutomationsOpen(true) : undefined
          }
          // A form adds its own rows, and draws none.
          onNewRow={
            canAdd && viewType !== "form" ? newRow.addAndOpen : undefined
          }
          shape={isGrid ? "grid" : viewType === "form" ? "form" : "rows"}
          filterOpen={filterOpen}
          onFilterOpen={setFilterOpen}
          savedAt={writes.savedAt}
          saveStatus={writes.saveStatus}
        />
        <ViewNotes
          view={activeView}
          description={config.description}
          editable={settings.editable}
        />
        {isGrid && rows.total > 0 ? <GridTips canEdit={writable} /> : null}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {isGrid && narrow ? (
              <RowCards {...viewProps} groupBy={groupBy} canAdd={canAdd} />
            ) : isGrid ? (
              <GridView
                rows={rows}
                columns={visible}
                widths={config.columnWidths ?? {}}
                frozen={config.frozenColumns ?? DEFAULT_FROZEN}
                rowHeight={config.rowHeight ?? "short"}
                groupBy={groupBy}
                tintOf={tintOf}
                canEdit={writable}
                canAdd={canAdd}
                canDelete={canDelete}
                canManage={canManage(role)}
                aggregations={aggregates.aggregations}
                aggregateValues={aggregates.values}
                presence={presence.filter(
                  (peer) => peer.viewId === activeView?.id,
                )}
                onActiveCell={onActiveCell}
                onAddRow={newRow.addInGrid}
                emptyHint={
                  hint ? (
                    <EmptyTableHint
                      hint={hint}
                      canImport={canImport}
                      onImport={() => setImportOpen(true)}
                    />
                  ) : null
                }
                onInsertRows={async (list) => {
                  await insertRows(list);
                }}
                onDeleteRows={deleteRows}
                onDuplicateRows={duplicateRows}
                onInsertBeside={byHand && canAdd ? newRow.addBeside : undefined}
                onMoveRows={byHand ? moveRows : undefined}
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
                  const next = { ...aggregates.aggregations };
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
                onHeaderAction={onHeaderAction}
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
            ) : viewType === "list" ? (
              <ListView {...viewProps} />
            ) : viewType === "calendar" ? (
              <CalendarView
                {...viewProps}
                month={read.calendarMonth}
                onMonth={read.setCalendarMonth}
                {...(activeView ? { viewId: activeView.id } : {})}
              />
            ) : viewType === "timeline" ? (
              <TimelineView
                {...viewProps}
                focus={read.timelineFocus}
                onFocus={read.setTimelineFocus}
              />
            ) : viewType === "form" ? (
              <FormView {...viewProps} canEdit={canAdd} />
            ) : (
              <MapView {...viewProps} />
            )}
          </div>
          {openRow ? (
            <RecordPanel
              row={openRow}
              columns={visible}
              onClose={record.close}
              onPrevious={record.previous}
              onNext={record.next}
              onDuplicate={
                canAdd && rowsById.has(openRow.id)
                  ? () => void duplicateRows([openRow.id])
                  : undefined
              }
              onDelete={
                canDelete
                  ? () => {
                      record.close();
                      void deleteRows([openRow.id]);
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
        <DeleteFieldDialog
          column={deleteColumn}
          onClose={() => setDeleteColumn(null)}
          onDelete={fields.remove}
        />
      ) : null}
      {reason.asking ? <ReasonDialog onAnswer={reason.answer} /> : null}
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
            void fields.readCatalog();
            rows.refresh();
          }}
        />
      ) : null}
      {trashOpen ? (
        <RowTrashDialog
          tableId={tableId}
          askReason={() => reason.ask(reason.everyField)}
          onClose={() => setTrashOpen(false)}
          onRestored={() => rows.refresh()}
        />
      ) : null}
      {newRow.filling ? (
        <NewRowDialog
          open
          columns={ordered}
          external={external !== null}
          initial={newRow.filling}
          onClose={newRow.stopFilling}
          onCreate={(values) => addRow(values, newRow.place)}
        />
      ) : null}
    </TableContext.Provider>
  );
}
