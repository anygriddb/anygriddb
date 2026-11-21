import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import type { Presence } from "../../lib/realtime";
import { placeBetween, type RowPlace } from "../../lib/row-place";
import { focusOutside } from "../../lib/tab-out";
import { useTRPC } from "../../lib/trpc";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { opensPanel } from "../fields/cell-editor";
import { DEFAULT_WIDTH } from "../fields/field-meta";
import { useTable, type CellValue } from "../table/table-context";
import { createLabelMeasure, defaultColumnWidth } from "./column-width";
import { GridCell } from "./grid-cell";
import { CheckedRowsBar } from "./grid-checked-bar";
import {
  isEditableColumn,
  isEditableLink,
  parseClipboard,
  planPaste,
  toTsv,
} from "./grid-clipboard";
import { clearUpdates, fillDownUpdates, fillSeriesUpdates } from "./grid-edits";
import { GridFooter } from "./grid-footer";
import { sheetGeometry } from "./grid-geometry";
import { GridHeader } from "./grid-header";
import { gridKeyAction } from "./grid-keys";
import { GridMenuItems } from "./grid-menu";
import {
  GRID_LIST,
  GridAddRow,
  GridDataRow,
  GridGroupRow,
  GridLimitRow,
} from "./grid-rows";
import { GridSkeleton } from "./grid-skeleton";
import {
  type GridItem,
  groupLevels,
  hasStarts,
  positionOf,
  readPrefix,
  viewItems,
} from "./group-layout";
import { ADD_FIELD_WIDTH, GUTTER, marginColumn } from "./margin-column";
import { RowsError } from "./rows-error";
import { cellId, GridSelection, type Cell, type Range } from "./selection";
import { SelectionSummaryBar } from "./selection-summary";
import type { RowsState } from "./use-rows";

const ROW_HEIGHTS = {
  short: 32,
  medium: 56,
  tall: 88,
  extra: 128,
} as const;
const HEADER = 32;
const FOOTER = 32;

type GridProps = {
  rows: RowsState;
  columns: readonly CatalogColumn[];
  widths: Readonly<Record<string, number>>;
  frozen: number;
  rowHeight: keyof typeof ROW_HEIGHTS;
  groupBy: ReadonlyArray<{ column: string; direction: "asc" | "desc" }>;
  /** Option colour name for a data row (select or colour rules). */
  tintOf?: (row: RowItem) => string | undefined;
  canEdit: boolean;
  /** Adding and deleting rows; a client's table enables them apart. */
  canAdd?: boolean;
  canDelete?: boolean;
  canManage: boolean;
  tableKeepsValues: boolean;
  aggregations: Readonly<Record<string, string>>;
  aggregateValues: ReadonlyArray<unknown> | undefined;
  presence: readonly Presence[];
  onActiveCell: (rowId: string | undefined, column: string | undefined) => void;
  onAddRow: () => Promise<void>;
  onInsertRows: (rows: Array<Record<string, CellValue>>) => Promise<void>;
  onDeleteRows: (rowIds: string[]) => Promise<void>;
  onDuplicateRows: (rowIds: string[]) => Promise<void>;
  /** A new row just above or just below another; unset where rows have no order of their own. */
  onInsertBeside?: (place: RowPlace) => Promise<void>;
  /**
   * Rows put beside another by hand, and where they were (`back`, for
   * undo); unset while the view sorts or groups its rows, or where they
   * cannot move.
   */
  onMoveRows?: (
    rowIds: string[],
    place: RowPlace,
    back: RowPlace | null,
  ) => Promise<void>;
  onResize: (column: string, width: number) => void;
  onReorder: (from: string, to: string) => void;
  onAggregate: (column: string, fn: string | null) => void;
  onAddField: (position?: number) => void;
  /** Said under the last line when no row is shown (`empty-table-hint`). */
  emptyHint?: ReactNode;
  onEditField: (column: CatalogColumn) => void;
  onHeaderAction: (
    action: string,
    column: CatalogColumn,
    index: number,
  ) => void;
};

/** Header labels measured once each, for the columns' default widths. */
const measureLabel = createLabelMeasure();

/** No rows read so far: one array, so the layout is not drawn again. */
const NONE_READ: readonly RowItem[] = [];

/** A row id no table has: a disabled query still needs valid input. */
const EMPTY_ROW_ID = "00000000-0000-4000-8000-000000000000";

export function GridView(props: GridProps) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const copy = useCopy();
  const canAdd = props.canAdd ?? props.canEdit;
  const canDelete = props.canDelete ?? props.canEdit;
  const table = useTable();
  const api = useTRPC();
  const { rows, columns, frozen } = props;
  const scroller = useRef<HTMLDivElement>(null);
  // The width the grid shows of its sheet, kept as the window changes:
  // the frozen columns are held to what leaves the others room to scroll.
  const [shown, setShown] = useState<number>();
  const attach = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    if (!node) return undefined;
    const measure = () => setShown(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      scroller.current = null;
    };
  }, []);
  // The selection lives outside React state: see selection.ts.
  const [selection] = useState(() => new GridSelection());
  const gridId = useId();
  const dragging = useRef(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rowHeight = ROW_HEIGHTS[props.rowHeight];
  const grouped = props.groupBy.length > 0;
  const onMoveRows = grouped ? undefined : props.onMoveRows;
  const onInsertBeside = grouped ? undefined : props.onInsertBeside;

  const widths = columns.map(
    (column) =>
      props.widths[column.name] ??
      defaultColumnWidth(
        column.fieldType,
        measureLabel(column.label),
        DEFAULT_WIDTH,
      ),
  );
  // The sheet ends after its last field, and the column that adds one; the
  // space past it only lets the last field scroll clear of the edge.
  const { offsets, sheetWidth, totalWidth, frozenCount, frozenWidth } =
    sheetGeometry(widths, frozen, props.canManage ? ADD_FIELD_WIDTH : 0, shown);

  // A grouped grid whose read said where each group starts places every
  // row at once; otherwise it lays out the rows read so far, in order, and
  // reads the next page as its end comes into view.
  const placed = grouped && hasStarts(rows.groups);
  const readSoFar = useMemo(
    () => (grouped && !placed ? readPrefix(rows.rowAt) : NONE_READ),
    [rows, grouped, placed],
  );
  const items: GridItem[] = useMemo(
    () =>
      viewItems({
        total: rows.total,
        levels: grouped ? groupLevels(props.groupBy, columns) : [],
        groups: rows.groups,
        readSoFar,
        collapsed,
        canAdd,
      }),
    [
      rows.total,
      rows.groups,
      grouped,
      readSoFar,
      props.groupBy,
      columns,
      collapsed,
      canAdd,
    ],
  );

  // Collapsing the groups listed folds everything: inner groups of a
  // folded one are not listed.
  const groupKeys = items.flatMap((item) =>
    item.type === "group" ? [item.key] : [],
  );
  const allCollapsed =
    groupKeys.length > 0 &&
    items.every(
      (item) =>
        item.type !== "group" || item.depth > 0 || collapsed.has(item.key),
    );

  // TanStack Virtual hands back a mutable instance, so the React Compiler
  // leaves this component as written; its manual memoization stays.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) =>
      items[index]?.type === "group"
        ? 36
        : items[index]?.type === "add" || items[index]?.type === "limit"
          ? 34
          : rowHeight,
    overscan: 10,
    scrollPaddingStart: HEADER,
    scrollPaddingEnd: FOOTER,
  });
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, items.length, rowVirtualizer]);

  const scrollable = columns.slice(frozenCount);
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: scrollable.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => widths[frozenCount + index] ?? 180,
    paddingStart: GUTTER + frozenWidth,
    overscan: 4,
  });
  const widthsKey = widths.join(",");
  useEffect(() => {
    columnVirtualizer.measure();
  }, [widthsKey, frozenCount, columnVirtualizer]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualColumns = columnVirtualizer.getVirtualItems();
  // Comments on the rows on screen, for the badge in the row header. A
  // client's rows carry comments too: they are kept in AnyGridDB.
  const shownIds = virtualRows.flatMap((virtual) => {
    const item = items[virtual.index];
    const row = item?.type === "row" ? rows.rowAt(item.index) : undefined;
    return row ? [row.id] : [];
  });
  const commentCounts = useQuery({
    ...api.rows.commentCounts.queryOptions({
      tableId: table.table.id,
      rowIds: shownIds.length > 0 ? shownIds.slice(0, 500) : [EMPTY_ROW_ID],
    }),
    enabled: shownIds.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const counts: Readonly<Record<string, number>> =
    commentCounts.data?.counts ?? {};
  // The rows on screen, by their place in the view: under group headers,
  // those of the first and last row lines drawn.
  let firstRow: number | undefined;
  let lastRow: number | undefined;
  for (const virtual of virtualRows) {
    const item = items[virtual.index];
    if (item?.type !== "row") continue;
    firstRow ??= item.index;
    lastRow = item.index;
  }
  const lastIndex = virtualRows[virtualRows.length - 1]?.index ?? 0;
  const endInView = lastIndex >= items.length - 1 - (canAdd ? 1 : 0);
  const moreToRead =
    grouped && !placed && readSoFar.length < rows.total && endInView;
  useEffect(() => {
    if (firstRow !== undefined && lastRow !== undefined) {
      rows.ensure(firstRow, lastRow);
    }
    if (moreToRead) rows.ensure(readSoFar.length, readSoFar.length);
  }, [firstRow, lastRow, moreToRead, readSoFar.length, rows]);

  const visibleRowIndexes = useMemo(
    () => items.flatMap((item) => (item.type === "row" ? [item.index] : [])),
    [items],
  );
  const rowAtPosition = (position: number): RowItem | undefined => {
    const index = visibleRowIndexes[position];
    return index === undefined ? undefined : rows.rowAt(index);
  };
  const positionOfRow = (index: number) => positionOf(visibleRowIndexes, index);
  /** Moves a row beside another; it can be put back between its neighbours. */
  const moveRow = (
    rowId: string,
    place: RowPlace,
    from: number | undefined,
  ) => {
    if (!onMoveRows) return;
    const back =
      from === undefined
        ? null
        : placeBetween(rows.rowAt(from - 1)?.id, rows.rowAt(from + 1)?.id);
    void onMoveRows([rowId], place, back);
  };
  /** Reads the rows shown from one place to another, folded ones aside. */
  const waitForPositions = (from: number, to: number) => {
    const first = visibleRowIndexes[from];
    const last = visibleRowIndexes[Math.min(to, visibleRowIndexes.length - 1)];
    return first === undefined || last === undefined
      ? Promise.resolve(true)
      : rows.waitFor(first, last);
  };

  // Presence and the screen reader's active cell follow the selection
  // without re-rendering the grid.
  const { onActiveCell } = props;
  const announced = useRef("");
  useEffect(() => {
    const sync = () => {
      const { active } = selection.getState();
      const row = active ? rowAtPosition(active.r) : undefined;
      const column = active ? columns[active.c] : undefined;
      const key = `${row?.id ?? ""}:${column?.name ?? ""}`;
      if (key !== announced.current) {
        announced.current = key;
        onActiveCell(row?.id, column?.name);
      }
      const grid = scroller.current;
      if (!grid) return;
      if (active) {
        grid.setAttribute(
          "aria-activedescendant",
          cellId(gridId, active.r, active.c),
        );
      } else {
        grid.removeAttribute("aria-activedescendant");
      }
    };
    sync();
    return selection.subscribe(sync);
  });

  const scrollTo = useCallback(
    (cell: Cell) => {
      const index = visibleRowIndexes[cell.r];
      const itemIndex = items.findIndex(
        (item) => item.type === "row" && item.index === index,
      );
      if (itemIndex >= 0)
        rowVirtualizer.scrollToIndex(itemIndex, { align: "auto" });
      if (cell.c >= frozenCount)
        columnVirtualizer.scrollToIndex(cell.c - frozenCount, {
          align: "auto",
        });
    },
    [visibleRowIndexes, items, rowVirtualizer, columnVirtualizer, frozenCount],
  );

  function move(cell: Cell, extend: boolean) {
    const { active, anchor } = selection.getState();
    const next = {
      r: Math.max(0, Math.min(visibleRowIndexes.length - 1, cell.r)),
      c: Math.max(0, Math.min(columns.length - 1, cell.c)),
    };
    selection.update({
      anchor: extend ? (anchor ?? active) : null,
      active: next,
    });
    scrollTo(next);
  }

  function selectedRows(): RowItem[] {
    const range = selection.getRange();
    if (!range) return [];
    const list: RowItem[] = [];
    for (let r = range.r1; r <= range.r2; r += 1) {
      const row = rowAtPosition(r);
      if (row) list.push(row);
    }
    return list;
  }

  /** The fields of a range, first to last. */
  const columnsOf = (range: Range) => columns.slice(range.c1, range.c2 + 1);

  /** The rows shown from one place to another, a hole for one not read. */
  const rowsBetween = (from: number, to: number) =>
    Array.from({ length: Math.max(to - from + 1, 0) }, (_, offset) =>
      rowAtPosition(from + offset),
    );

  async function clearRange() {
    const range = selection.getRange();
    if (!range || !props.canEdit) return;
    const updates = clearUpdates(selectedRows(), columnsOf(range));
    if (updates.length > 0) await table.updateCells(updates);
  }

  async function fillDown(target: Range) {
    const ready = await waitForPositions(target.r1, target.r2);
    if (!ready) {
      toast.error(t`Could not load the rows to fill`);
      return;
    }
    const updates = fillDownUpdates(
      rowsBetween(target.r1, target.r2),
      columnsOf(target),
    );
    if (updates.length > 0) await table.updateCells(updates);
  }

  async function applyFill(to: number) {
    const held = selection.getState();
    const range = selection.getRange();
    if (!range) return;
    const count = to - range.r2;
    if (count <= 0) return;
    const ready = await waitForPositions(range.r1, range.r2 + count);
    if (!ready) {
      toast.error(t`Could not load the rows to fill`);
      return;
    }
    const updates = fillSeriesUpdates(
      selectedRows(),
      rowsBetween(range.r2 + 1, range.r2 + count),
      columnsOf(range),
    );
    if (updates.length > 0) await table.updateCells(updates);
    // The range grows over what it filled.
    selection.updateIfStill(held, {
      anchor: { r: range.r1, c: range.c1 },
      active: { r: range.r2 + count, c: range.c2 },
    });
  }

  function startEdit(cell: Cell, text?: string) {
    const column = columns[cell.c];
    const row = rowAtPosition(cell.r);
    if (
      !column ||
      !row ||
      !props.canEdit ||
      (!isEditableColumn(column) && !isEditableLink(column))
    )
      return;
    if (row.ag_status === "locked" || row.ag_status === "signed") {
      toast.error(t`Row locked`);
      return;
    }
    if (column.fieldType === "boolean") {
      void table.updateCells([
        {
          rowId: row.id,
          values: { [column.name]: !row[column.name as keyof RowItem] },
        },
      ]);
      return;
    }
    selection.update({
      editing: { cell, text: opensPanel(column.fieldType) ? undefined : text },
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keys pressed on a control the grid holds (a field's menu, the line
    // that adds a row) are that control's: only the grid's own drive it.
    if (event.target !== event.currentTarget) return;
    const { active, editing } = selection.getState();
    if (editing) return;
    const action = gridKeyAction(event, {
      active,
      rows: visibleRowIndexes.length,
      columns: columns.length,
    });
    if (!action || !active) {
      if (action?.kind === "move") {
        event.preventDefault();
        move(action.cell, action.extend);
      }
      return;
    }
    const activeRow = rowAtPosition(active.r);
    const range = selection.getRange();
    switch (action.kind) {
      case "move":
        event.preventDefault();
        move(action.cell, action.extend);
        return;
      case "leave":
        // The key is the browser's unless the grid found where to go.
        if (focusOutside(event.currentTarget, action.backward)) {
          event.preventDefault();
        }
        return;
      case "edit":
        event.preventDefault();
        startEdit(active, action.text);
        return;
      case "open":
        event.preventDefault();
        if (activeRow) table.openRecord(activeRow.id);
        return;
      case "deselect":
        selection.update({ anchor: null });
        return;
      case "clear":
        event.preventDefault();
        void clearRange();
        return;
      case "fillDown":
        event.preventDefault();
        if (range) void fillDown(range);
        return;
      case "selectAll":
        event.preventDefault();
        selection.update({
          anchor: { r: 0, c: 0 },
          active: {
            r: visibleRowIndexes.length - 1,
            c: columns.length - 1,
          },
        });
        return;
    }
  }

  function onCopy(event: ClipboardEvent<HTMLDivElement>) {
    const range = selection.getRange();
    if (selection.getState().editing || !range) return;
    event.preventDefault();
    const text = toTsv(
      selectedRows(),
      columns.slice(range.c1, range.c2 + 1),
      table.locale,
      table.people,
    );
    event.clipboardData.setData("text/plain", text);
    const cells = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    toast.success(
      plural(cells, { one: "# cell copied", other: "# cells copied" }),
    );
  }

  async function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    const held = selection.getState();
    const { active, editing } = held;
    const range = selection.getRange();
    if (editing || !active || !props.canEdit) return;
    event.preventDefault();
    const matrix = parseClipboard(event.clipboardData.getData("text/plain"));
    const start = range ? { r: range.r1, c: range.c1 } : active;
    const needed = Math.max(matrix.length, range ? range.r2 - range.r1 + 1 : 1);
    const end = Math.min(
      start.r + needed - 1,
      Math.max(visibleRowIndexes.length - 1, 0),
    );
    if (end >= start.r) {
      const ready = await waitForPositions(start.r, end);
      if (!ready) {
        toast.error(t`Could not load the rows to paste into`);
        return;
      }
    }
    const loadedRows: RowItem[] = [];
    for (let r = start.r; r < start.r + needed; r += 1) {
      const row = rowAtPosition(r);
      if (row) loadedRows[r - start.r] = row;
      else if (r < visibleRowIndexes.length) {
        toast.error(t`Could not load the rows to paste into`);
        return;
      }
    }
    const people = [...table.people.values()];
    const plan = planPaste({
      matrix,
      rows: loadedRows,
      columns,
      startRow: 0,
      startColumn: start.c,
      range: range
        ? { rows: range.r2 - range.r1 + 1, columns: range.c2 - range.c1 + 1 }
        : undefined,
      resolveUser: (text) =>
        people.find(
          (person) => person.displayName.toLowerCase() === text.toLowerCase(),
        )?.id,
    });
    for (let index = 0; index < plan.updates.length; index += 500) {
      await table.updateCells(plan.updates.slice(index, index + 500));
    }
    if (plan.inserts.length > 0 && !grouped && canAdd) {
      await props.onInsertRows(plan.inserts);
    }
    if (plan.skipped > 0) {
      toast.warning(
        plural(plan.skipped, {
          one: "# cell skipped: incompatible value or computed field",
          other: "# cells skipped: incompatible value or computed field",
        }),
      );
    }
    // What was pasted becomes the selection.
    selection.updateIfStill(held, {
      anchor: start,
      active: {
        r: start.r + Math.max(matrix.length, 1) - 1,
        c: Math.min(columns.length - 1, start.c + (matrix[0]?.length ?? 1) - 1),
      },
    });
  }

  function cellPointerDown(event: ReactPointerEvent, cell: Cell) {
    if (event.button !== 0) return;
    const { active, anchor, editing } = selection.getState();
    scroller.current?.focus({ preventScroll: true });
    if (event.shiftKey && active) {
      selection.update({ anchor: anchor ?? active, active: cell });
      return;
    }
    const leaving =
      editing && (editing.cell.r !== cell.r || editing.cell.c !== cell.c);
    selection.update({
      anchor: null,
      active: cell,
      ...(leaving ? { editing: null } : {}),
    });
    dragging.current = true;
  }

  function cellPointerEnter(cell: Cell) {
    const { active, anchor, fillTo } = selection.getState();
    const range = selection.getRange();
    if (fillTo !== null && range) {
      selection.update({ fillTo: Math.max(range.r2, cell.r) });
      return;
    }
    if (dragging.current && active) {
      selection.update({ anchor: anchor ?? active, active: cell });
    }
  }

  useEffect(() => {
    const up = () => {
      dragging.current = false;
      const { fillTo } = selection.getState();
      if (fillTo === null) return;
      selection.update({ fillTo: null });
      void applyFill(fillTo);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  });

  const presenceByCell = useMemo(() => {
    const map = new Map<string, Presence>();
    for (const peer of props.presence) {
      if (peer.rowId && peer.column)
        map.set(`${peer.rowId}:${peer.column}`, peer);
    }
    return map;
  }, [props.presence]);

  function renderCell(
    row: RowItem | undefined,
    position: number,
    columnIndex: number,
  ) {
    const column = columns[columnIndex];
    if (!column) return null;
    return (
      <GridCell
        key={column.name}
        selection={selection}
        grid={gridId}
        row={row}
        position={position}
        columnIndex={columnIndex}
        column={column}
        width={widths[columnIndex] ?? 180}
        left={columnIndex < frozenCount ? offsets[columnIndex] : undefined}
        margin={columnIndex === marginColumn(frozenCount)}
        height={rowHeight}
        wrap={props.rowHeight !== "short"}
        canEdit={props.canEdit}
        peer={row ? presenceByCell.get(`${row.id}:${column.name}`) : undefined}
        onPointerDown={cellPointerDown}
        onPointerEnter={cellPointerEnter}
        onEdit={startEdit}
        onEditDone={(cell, direction) => {
          selection.update({ editing: null });
          scroller.current?.focus({ preventScroll: true });
          if (direction === "down") move({ r: cell.r + 1, c: cell.c }, false);
          if (direction === "right") move({ r: cell.r, c: cell.c + 1 }, false);
          if (direction === "left") move({ r: cell.r, c: cell.c - 1 }, false);
        }}
        onFillStart={() => {
          const range = selection.getRange();
          if (range) selection.update({ fillTo: range.r2 });
        }}
      />
    );
  }

  const rowsOfSelection = () =>
    checked.size > 0 ? [...checked] : selectedRows().map((row) => row.id);

  if (rows.error) {
    return (
      <RowsError
        error={rows.error}
        onRetry={rows.refresh}
        tableId={table.table.external ? table.table.id : undefined}
      />
    );
  }
  if (rows.loading) {
    return <GridSkeleton />;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {checked.size > 0 ? (
        <CheckedRowsBar
          count={checked.size}
          onDeselect={() => setChecked(new Set())}
          onDuplicate={
            canAdd
              ? () =>
                  void props
                    .onDuplicateRows([...checked])
                    .then(() => setChecked(new Set()))
              : undefined
          }
          onDelete={
            canDelete
              ? () =>
                  void props
                    .onDeleteRows([...checked])
                    .then(() => setChecked(new Set()))
              : undefined
          }
        />
      ) : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={attach}
            role="grid"
            aria-label={t`Table rows`}
            aria-multiselectable
            // The header row, and the row header column of numbers.
            // The header row, the rows, and the summary row; the row
            // header, the fields, and the column that adds one.
            aria-rowcount={rows.total + 2}
            aria-colcount={columns.length + 1 + (props.canManage ? 1 : 0)}
            tabIndex={0}
            className="relative min-h-0 flex-1 overflow-auto outline-none select-none"
            // A control that takes the keyboard among the columns that
            // scroll is brought clear of those that stay, not under them.
            style={{ scrollPaddingLeft: GUTTER + frozenWidth }}
            onKeyDown={onKeyDown}
            onCopy={onCopy}
            onPaste={(event) => void onPaste(event)}
          >
            <div style={{ width: totalWidth, position: "relative" }}>
              <GridHeader
                columns={columns}
                widths={widths}
                offsets={offsets}
                frozenCount={frozenCount}
                virtualColumns={virtualColumns.map(
                  (item) => item.index + frozenCount,
                )}
                padStart={
                  (virtualColumns[0]?.start ?? GUTTER + frozenWidth) -
                  GUTTER -
                  frozenWidth
                }
                width={totalWidth}
                canManage={props.canManage}
                tableKeepsValues={props.tableKeepsValues}
                allChecked={
                  checked.size > 0 && checked.size >= rows.loadedRows().length
                }
                loadedCount={rows.loadedRows().length}
                onToggleAll={(value) =>
                  setChecked(
                    value
                      ? new Set(rows.loadedRows().map((row) => row.id))
                      : new Set(),
                  )
                }
                onResize={props.onResize}
                onReorder={props.onReorder}
                onAddField={() => props.onAddField()}
                onEditField={props.onEditField}
                onAction={props.onHeaderAction}
              />
              {virtualRows.map((virtual) => {
                const item = items[virtual.index];
                if (!item) return null;
                const line = {
                  top: virtual.start + HEADER,
                  height: virtual.size,
                  width: totalWidth,
                };
                if (item.type === "group") {
                  return (
                    <GridGroupRow
                      key={`g-${item.key}`}
                      item={item}
                      line={line}
                      span={columns.length + 1}
                      folded={collapsed.has(item.key)}
                      onFold={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(item.key)) next.delete(item.key);
                          else next.add(item.key);
                          return next;
                        })
                      }
                      allFolded={allCollapsed}
                      onFoldAll={() =>
                        setCollapsed(
                          allCollapsed ? new Set() : new Set(groupKeys),
                        )
                      }
                    />
                  );
                }
                if (item.type === "limit") {
                  return (
                    <GridLimitRow
                      key="group-limit"
                      line={line}
                      span={columns.length + 1}
                    />
                  );
                }
                if (item.type === "add") {
                  return (
                    <GridAddRow
                      key="add-row"
                      line={line}
                      span={columns.length + 1}
                      sheetWidth={sheetWidth}
                      frozenCount={frozenCount}
                      onAdd={() => void props.onAddRow()}
                    />
                  );
                }
                const position = positionOfRow(item.index);
                const row = rows.rowAt(item.index);
                return (
                  <GridDataRow
                    key={row?.id ?? `r-${item.index}`}
                    selection={selection}
                    row={row}
                    index={item.index}
                    position={position}
                    line={line}
                    rowHeight={rowHeight}
                    frozenCount={frozenCount}
                    tint={row && props.tintOf ? props.tintOf(row) : undefined}
                    checked={row ? checked.has(row.id) : false}
                    onCheck={(value) => {
                      if (!row) return;
                      setChecked((current) => {
                        const next = new Set(current);
                        if (value) next.add(row.id);
                        else next.delete(row.id);
                        return next;
                      });
                    }}
                    comments={row ? (counts[row.id] ?? 0) : 0}
                    onOpen={() => {
                      if (row) table.openRecord(row.id);
                    }}
                    slot={
                      onMoveRows
                        ? { list: GRID_LIST, index: item.index }
                        : undefined
                    }
                    onPlace={moveRow}
                  >
                    {Array.from({ length: frozenCount }, (_, columnIndex) =>
                      renderCell(row, position, columnIndex),
                    )}
                    <div
                      aria-hidden
                      className="shrink-0"
                      style={{
                        width:
                          (virtualColumns[0]?.start ?? GUTTER + frozenWidth) -
                          GUTTER -
                          frozenWidth,
                      }}
                    />
                    {virtualColumns.map((virtualColumn) =>
                      renderCell(
                        row,
                        position,
                        virtualColumn.index + frozenCount,
                      ),
                    )}
                  </GridDataRow>
                );
              })}
              <div style={{ height: rowVirtualizer.getTotalSize() }} />
              <GridFooter
                columns={columns}
                widths={widths}
                offsets={offsets}
                frozenCount={frozenCount}
                virtualColumns={virtualColumns.map(
                  (item) => item.index + frozenCount,
                )}
                padStart={
                  (virtualColumns[0]?.start ?? GUTTER + frozenWidth) -
                  GUTTER -
                  frozenWidth
                }
                width={totalWidth}
                trailingWidth={props.canManage ? ADD_FIELD_WIDTH : 0}
                total={rows.total}
                {...(rows.totalEstimated
                  ? {
                      estimated: {
                        onCount: () => {
                          rows.countExactly().catch((cause: unknown) => {
                            toast.error(errorText(cause));
                          });
                        },
                      },
                    }
                  : {})}
                aggregations={props.aggregations}
                values={props.aggregateValues}
                onAggregate={props.onAggregate}
              />
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={t`Actions`}>
          <GridMenuItems
            selection={selection}
            rowAtPosition={rowAtPosition}
            canAdd={canAdd}
            canDelete={canDelete}
            onInsertBeside={
              onInsertBeside ? (place) => void onInsertBeside(place) : undefined
            }
            onMove={
              onMoveRows
                ? (rowId, place, back) => void onMoveRows([rowId], place, back)
                : undefined
            }
            onCopy={() => {
              const range = selection.getRange();
              if (!range) return;
              const text = toTsv(
                selectedRows(),
                columns.slice(range.c1, range.c2 + 1),
                table.locale,
                table.people,
              );
              copy(text);
            }}
            onDuplicate={() => void props.onDuplicateRows(rowsOfSelection())}
            onDelete={() => void props.onDeleteRows(rowsOfSelection())}
          />
        </ContextMenuContent>
      </ContextMenu>
      {props.emptyHint && rows.total === 0 ? (
        // Under the grid's lines, lined up with "Add a row"; outside the
        // grid itself, whose children are rows only.
        <div
          className="absolute right-4 max-w-md"
          style={{
            top: HEADER + (canAdd ? 34 : 0) + FOOTER + 24,
            left: GUTTER + 8,
          }}
        >
          {props.emptyHint}
        </div>
      ) : null}
      <SelectionSummaryBar
        selection={selection}
        columns={columns}
        rowAt={rowAtPosition}
      />
    </div>
  );
}
