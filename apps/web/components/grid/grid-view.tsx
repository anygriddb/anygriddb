import { MAX_GROUPS } from "@anygriddb/core";
import { RowsError } from "./rows-error";

import {
  Checkbox,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@anygriddb/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  Expand,
  Link as LinkIcon,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type ClipboardEvent,
  type CSSProperties,
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
import { useRowDrag, useRowPlaceDrop, type ListSlot } from "../../lib/drag";
import { placeBetween, type RowPlace } from "../../lib/row-place";
import type { Presence } from "../../lib/realtime";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { useErrorText } from "../../lib/errors";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useTRPC } from "../../lib/trpc";
import { opensPanel } from "../fields/cell-editor";
import { optionsOf } from "../fields/cell-value";
import { DEFAULT_WIDTH } from "../fields/field-meta";
import { useTable, type CellValue } from "../table/table-context";
import { createLabelMeasure, defaultColumnWidth } from "./column-width";
import { GridFooter } from "./grid-footer";
import { GridCell } from "./grid-cell";
import { GridHeader } from "./grid-header";
import { GridSkeleton } from "./grid-skeleton";
import { ADD_FIELD_WIDTH, GUTTER, marginColumn } from "./margin-column";
import { SelectionSummaryBar } from "./selection-summary";
import {
  cellId,
  GridSelection,
  useEditingRow,
  useSelectionState,
  type Cell,
  type Range,
} from "./selection";
import {
  fillValues,
  isEditableColumn,
  isEditableLink,
  parseClipboard,
  planPaste,
  toTsv,
} from "./grid-clipboard";
import {
  type GridItem,
  type GroupLevel,
  hasStarts,
  layoutFromRows,
  layoutFromStarts,
  positionOf,
} from "./group-layout";
import type { RowsState } from "./use-rows";
import { useLingui } from "@lingui/react/macro";
import { plural } from "@lingui/core/macro";

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
  const { locale } = useLocale();
  const errorText = useErrorText();
  const copy = useCopy();
  const canAdd = props.canAdd ?? props.canEdit;
  const canDelete = props.canDelete ?? props.canEdit;
  const table = useTable();
  const api = useTRPC();
  const { rows, columns, frozen } = props;
  const scroller = useRef<HTMLDivElement>(null);
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
  const offsets: number[] = [];
  let running = GUTTER;
  for (const width of widths) {
    offsets.push(running);
    running += width;
  }
  // The sheet ends after its last field, and the column that adds one; the
  // space past it only lets the last field scroll clear of the edge.
  const sheetWidth = running + (props.canManage ? ADD_FIELD_WIDTH : 0);
  const totalWidth = running + 120;
  const frozenCount = Math.min(frozen, columns.length);
  const frozenWidth = (offsets[frozenCount] ?? running) - GUTTER;

  // A grouped grid whose read said where each group starts places every
  // row at once; otherwise it lays out the rows read so far, in order, and
  // reads the next page as its end comes into view.
  const placed = grouped && hasStarts(rows.groups);
  const readSoFar = useMemo(() => {
    if (!grouped || placed) return NONE_READ;
    const prefix: RowItem[] = [];
    for (let row = rows.rowAt(0); row; row = rows.rowAt(prefix.length)) {
      prefix.push(row);
    }
    return prefix;
  }, [rows, grouped, placed]);
  const items: GridItem[] = useMemo(() => {
    let list: GridItem[] = [];
    if (!grouped) {
      for (let index = 0; index < rows.total; index += 1)
        list.push({ type: "row", index });
    } else {
      const levels: GroupLevel[] = props.groupBy.map((group) => {
        const column = columns.find((item) => item.name === group.column);
        const colored =
          column?.fieldType === "single_select" ||
          column?.fieldType === "multi_select";
        return {
          column: group.column,
          ...(colored
            ? {
                colorOf: (label: string) =>
                  optionsOf(column).find((option) => option.name === label)
                    ?.color,
              }
            : {}),
        };
      });
      list = placed
        ? layoutFromStarts(rows.groups, levels, collapsed, MAX_GROUPS)
        : layoutFromRows(readSoFar, levels, collapsed, rows.groups);
    }
    if (canAdd) list.push({ type: "add" });
    return list;
  }, [
    rows.total,
    rows.groups,
    grouped,
    placed,
    readSoFar,
    props.groupBy,
    columns,
    collapsed,
    canAdd,
  ]);

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

  const rowIndexOfItem = (item: GridItem | undefined): number | undefined =>
    item?.type === "row" ? item.index : undefined;
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

  async function clearRange() {
    const range = selection.getRange();
    if (!range || !props.canEdit) return;
    const targets = columns
      .slice(range.c1, range.c2 + 1)
      .filter(isEditableColumn);
    if (targets.length === 0) return;
    const updates = selectedRows().map((row) => ({
      rowId: row.id,
      values: Object.fromEntries(targets.map((column) => [column.name, null])),
    }));
    await table.updateCells(updates);
  }

  async function fillDown(target: Range) {
    const ready = await waitForPositions(target.r1, target.r2);
    if (!ready) {
      toast.error(t`Could not load the rows to fill`);
      return;
    }
    const sourceRow = rowAtPosition(target.r1);
    if (!sourceRow) return;
    const targets = columns
      .slice(target.c1, target.c2 + 1)
      .filter(isEditableColumn);
    const updates: Array<{ rowId: string; values: Record<string, CellValue> }> =
      [];
    for (let r = target.r1 + 1; r <= target.r2; r += 1) {
      const row = rowAtPosition(r);
      if (!row) continue;
      updates.push({
        rowId: row.id,
        values: Object.fromEntries(
          targets.map((column) => [
            column.name,
            (sourceRow[column.name as keyof RowItem] ?? null) as CellValue,
          ]),
        ),
      });
    }
    if (updates.length > 0) await table.updateCells(updates);
  }

  async function applyFill(to: number) {
    const range = selection.getRange();
    if (!range) return;
    const count = to - range.r2;
    if (count <= 0) return;
    const ready = await waitForPositions(range.r1, range.r2 + count);
    if (!ready) {
      toast.error(t`Could not load the rows to fill`);
      return;
    }
    const targets = columns
      .slice(range.c1, range.c2 + 1)
      .filter(isEditableColumn);
    const sourceRows = selectedRows();
    const updates: Array<{ rowId: string; values: Record<string, CellValue> }> =
      [];
    const series = Object.fromEntries(
      targets.map((column) => [
        column.name,
        fillValues(
          sourceRows.map(
            (row) => (row[column.name as keyof RowItem] ?? null) as CellValue,
          ),
          count,
        ),
      ]),
    );
    for (let offset = 0; offset < count; offset += 1) {
      const row = rowAtPosition(range.r2 + 1 + offset);
      if (!row) continue;
      updates.push({
        rowId: row.id,
        values: Object.fromEntries(
          targets.map((column) => [
            column.name,
            series[column.name]?.[offset] ?? null,
          ]),
        ),
      });
    }
    if (updates.length > 0) await table.updateCells(updates);
    selection.update({
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
    const { active, editing } = selection.getState();
    const range = selection.getRange();
    if (editing) return;
    const activeRow = active ? rowAtPosition(active.r) : undefined;
    const mod = event.ctrlKey || event.metaKey;
    if (!active) {
      if (event.key.startsWith("Arrow") && visibleRowIndexes.length > 0) {
        event.preventDefault();
        move({ r: 0, c: 0 }, false);
      }
      return;
    }
    const lastRow = visibleRowIndexes.length - 1;
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        move({ r: mod ? 0 : active.r - 1, c: active.c }, event.shiftKey);
        return;
      case "ArrowDown":
        event.preventDefault();
        move({ r: mod ? lastRow : active.r + 1, c: active.c }, event.shiftKey);
        return;
      case "ArrowLeft":
        event.preventDefault();
        move({ r: active.r, c: mod ? 0 : active.c - 1 }, event.shiftKey);
        return;
      case "ArrowRight":
        event.preventDefault();
        move(
          { r: active.r, c: mod ? columns.length - 1 : active.c + 1 },
          event.shiftKey,
        );
        return;
      case "Tab":
        event.preventDefault();
        move({ r: active.r, c: active.c + (event.shiftKey ? -1 : 1) }, false);
        return;
      case "Home":
        event.preventDefault();
        move({ r: mod ? 0 : active.r, c: 0 }, event.shiftKey);
        return;
      case "End":
        event.preventDefault();
        move(
          { r: mod ? lastRow : active.r, c: columns.length - 1 },
          event.shiftKey,
        );
        return;
      case "PageDown":
        event.preventDefault();
        move({ r: active.r + 15, c: active.c }, event.shiftKey);
        return;
      case "PageUp":
        event.preventDefault();
        move({ r: active.r - 15, c: active.c }, event.shiftKey);
        return;
      case "Enter":
      case "F2":
        event.preventDefault();
        if (event.shiftKey && activeRow) table.openRecord(activeRow.id);
        else startEdit(active);
        return;
      case " ":
        if (!mod) {
          event.preventDefault();
          if (activeRow) table.openRecord(activeRow.id);
        }
        return;
      case "Escape":
        selection.update({ anchor: null });
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        void clearRange();
        return;
    }
    if (mod && event.key.toLowerCase() === "d" && range) {
      event.preventDefault();
      void fillDown(range);
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selection.update({
        anchor: { r: 0, c: 0 },
        active: { r: lastRow, c: columns.length - 1 },
      });
      return;
    }
    if (!mod && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      startEdit(active, event.key);
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
    toast.success(t`${{ count: cells }} cells copied`);
  }

  async function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    const { active, editing } = selection.getState();
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
        t`${{ count: plan.skipped }} cells skipped: incompatible value or computed field`,
      );
    }
    selection.update({
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
        <div className="absolute top-1 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-sm border border-border bg-card px-3 py-1.5 text-sm shadow-lg">
          <span>{t`${{ count: checked.size }} rows selected`}</span>
          <button
            type="button"
            className="rounded px-2 py-0.5 hover:bg-muted"
            onClick={() => setChecked(new Set())}
          >
            {t`Deselect`}
          </button>
          {canAdd ? (
            <button
              type="button"
              className="rounded px-2 py-0.5 hover:bg-muted"
              onClick={async () => {
                await props.onDuplicateRows([...checked]);
                setChecked(new Set());
              }}
            >
              {t`Duplicate`}
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="rounded px-2 py-0.5 text-danger hover:bg-muted"
              onClick={async () => {
                await props.onDeleteRows([...checked]);
                setChecked(new Set());
              }}
            >
              {t`Delete`}
            </button>
          ) : null}
        </div>
      ) : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scroller}
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
                const top = virtual.start + HEADER;
                if (item.type === "group") {
                  return (
                    <div
                      key={`g-${item.key}`}
                      role="row"
                      className="group/group absolute left-0 flex items-center gap-2 border-b border-rule bg-head px-2 text-sm font-medium"
                      style={{
                        top,
                        height: virtual.size,
                        width: totalWidth,
                        paddingLeft: 8 + item.depth * 20,
                      }}
                    >
                      <div
                        role="gridcell"
                        aria-colspan={columns.length + 1}
                        className="contents"
                      >
                        {/* Named by what it shows; folded or not, it says. */}
                        <button
                          type="button"
                          aria-expanded={!collapsed.has(item.key)}
                          className="sticky left-2 flex items-center gap-2"
                          onClick={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(item.key)) next.delete(item.key);
                              else next.add(item.key);
                              return next;
                            })
                          }
                        >
                          {collapsed.has(item.key) ? (
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          ) : (
                            <ChevronDown className="h-4 w-4" aria-hidden />
                          )}
                          {item.color ? (
                            <span
                              className={`opt-${item.color} rounded-full px-2 text-xs`}
                            >
                              {item.label || t`(empty)`}
                            </span>
                          ) : (
                            <span>{item.label || t`(empty)`}</span>
                          )}
                          <span className="text-xs font-normal text-muted-foreground">
                            {item.count}
                          </span>
                        </button>
                        {item.depth === 0 ? (
                          <button
                            type="button"
                            className="sticky right-2 ml-auto rounded px-2 text-xs font-normal text-muted-foreground opacity-0 group-hover/group:opacity-100 hover:bg-card hover:text-foreground focus-visible:opacity-100"
                            onClick={() =>
                              setCollapsed(
                                allCollapsed ? new Set() : new Set(groupKeys),
                              )
                            }
                          >
                            {allCollapsed ? t`Expand all` : t`Collapse all`}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                }
                if (item.type === "limit") {
                  const limit = formatNumber(MAX_GROUPS, locale);
                  return (
                    <div
                      key="group-limit"
                      role="row"
                      className="absolute left-0 flex items-center border-b border-rule px-3 text-[13px] text-muted-foreground"
                      style={{ top, height: virtual.size, width: totalWidth }}
                    >
                      <div
                        role="gridcell"
                        aria-colspan={columns.length + 1}
                        className="sticky left-3"
                      >
                        {t`The first ${limit} groups are shown: filter the view to see the others.`}
                      </div>
                    </div>
                  );
                }
                if (item.type === "add") {
                  return (
                    <div
                      key="add-row"
                      role="row"
                      className="absolute left-0 flex"
                      style={{ top, height: virtual.size, width: totalWidth }}
                    >
                      <div
                        role="gridcell"
                        aria-colspan={columns.length + 1}
                        className="contents"
                      >
                        <button
                          type="button"
                          className="group/add flex h-full items-center border-b border-rule text-[13px] text-muted-foreground hover:text-foreground"
                          style={{ width: sheetWidth }}
                          onClick={() => void props.onAddRow()}
                        >
                          {/* The gutter's share of the row: the plus sits where the numbers do. */}
                          <span
                            className={cn(
                              "sticky left-0 flex h-full shrink-0 items-center justify-end border-r border-rule bg-head px-2 group-hover/add:bg-muted",
                              marginColumn(frozenCount) === -1 &&
                                "border-r-2 border-r-margin",
                            )}
                            style={{ width: GUTTER }}
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                          </span>
                          <span className="px-2 group-hover/add:bg-muted">
                            {t`Add a row`}
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                }
                const position = positionOfRow(rowIndexOfItem(item) ?? -1);
                const row = rows.rowAt(item.index);
                const tint =
                  row && props.tintOf ? props.tintOf(row) : undefined;
                const slot: ListSlot | undefined =
                  onMoveRows && row
                    ? { list: GRID_LIST, index: item.index }
                    : undefined;
                return (
                  <EditingRow
                    key={row?.id ?? `r-${item.index}`}
                    selection={selection}
                    position={position}
                    rowIndex={item.index + 2}
                    className="group/row absolute left-0 flex"
                    style={{ top, height: virtual.size, width: totalWidth }}
                    drop={
                      slot && row
                        ? { ...slot, rowId: row.id, onPlace: moveRow }
                        : undefined
                    }
                    onContextMenu={() => {
                      const range = selection.getRange();
                      if (
                        !range ||
                        position < range.r1 ||
                        position > range.r2
                      ) {
                        selection.update({
                          anchor: null,
                          active: {
                            r: position,
                            c: selection.getState().active?.c ?? 0,
                          },
                        });
                      }
                    }}
                  >
                    <RowGutter
                      rowId={row?.id}
                      label={t`Row ${{ number: String(item.index + 1) }}`}
                      // A locked or signed row stays where it is; others
                      // can still be put beside it.
                      slot={row && isFixed(row) ? undefined : slot}
                      className={cn(
                        "sticky left-0 z-[6] flex shrink-0 items-center gap-1.5 border-r border-b border-rule bg-head px-1.5 font-mono text-xs text-muted-foreground",
                        marginColumn(frozenCount) === -1 &&
                          "border-r-2 border-r-margin",
                        tint && `row-tint-${tint}`,
                      )}
                      style={{ width: GUTTER, height: rowHeight }}
                    >
                      <Checkbox
                        aria-label={t`Select row ${{ index: item.index + 1 }}`}
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          !checked.has(row?.id ?? "") &&
                            "opacity-0 group-hover/row:opacity-100",
                        )}
                        checked={row ? checked.has(row.id) : false}
                        onChange={(event) =>
                          row &&
                          setChecked((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          })
                        }
                      />
                      <span
                        className={cn(
                          "flex-1 text-right tabular-nums",
                          checked.has(row?.id ?? "")
                            ? "hidden"
                            : "group-hover/row:hidden",
                        )}
                      >
                        {/* Its rank in the view, as a spreadsheet numbers
                            its lines: the row's own number, which never
                            changes, is the record panel's. */}
                        {item.index + 1}
                      </span>
                      {row ? (
                        <button
                          type="button"
                          aria-label={t`Expand row`}
                          className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-foreground hover:bg-muted group-hover/row:inline-flex"
                          onClick={() => table.openRecord(row.id)}
                        >
                          <Expand className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      ) : null}
                      {row && (counts[row.id] ?? 0) > 0 ? (
                        <button
                          type="button"
                          className="inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded px-0.5 text-[10px] hover:bg-muted group-hover/row:hidden"
                          aria-label={plural(counts[row.id] ?? 0, {
                            one: `# comment`,
                            other: `# comments`,
                          })}
                          onClick={() => table.openRecord(row.id)}
                        >
                          <MessageSquare className="h-3 w-3" aria-hidden />
                          {counts[row.id]}
                        </button>
                      ) : null}
                      {row &&
                      (row.ag_status === "locked" ||
                        row.ag_status === "signed") ? (
                        <span title={row.ag_status} className="text-[10px]">
                          🔒
                        </span>
                      ) : null}
                      {row?.drift ? (
                        <span
                          role="img"
                          aria-label={t`Changed outside AnyGridDB since it was locked`}
                          title={t`Changed outside AnyGridDB since it was locked`}
                        >
                          <AlertTriangle
                            className="h-3.5 w-3.5 text-danger"
                            aria-hidden
                          />
                        </span>
                      ) : null}
                    </RowGutter>
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
                  </EditingRow>
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

/**
 * A body row that rises above later virtualized rows while one of its
 * cells is edited, so an overflowing list panel keeps the pointer.
 */
function EditingRow(props: {
  selection: GridSelection;
  position: number;
  rowIndex: number;
  className?: string;
  style?: CSSProperties;
  onContextMenu?: () => void;
  /** Where a row dropped on this one goes, when rows move by hand. */
  drop?: ListSlot & {
    rowId: string;
    onPlace: (rowId: string, place: RowPlace, from: number | undefined) => void;
  };
  children: ReactNode;
}) {
  const editing = useEditingRow(props.selection, props.position);
  const ref = useRef<HTMLDivElement>(null);
  const drop = props.drop;
  const { dropProps, side } = useRowPlaceDrop(
    ref,
    {
      list: drop?.list ?? GRID_LIST,
      index: drop?.index ?? -1,
      rowId: drop?.rowId ?? "",
    },
    (rowId, place, from) => drop?.onPlace(rowId, place, from),
    drop !== undefined,
  );
  return (
    <div
      {...(drop ? dropProps : {})}
      ref={ref}
      role="row"
      aria-rowindex={props.rowIndex}
      className={cn(props.className, editing && "z-40")}
      style={props.style}
      onContextMenu={props.onContextMenu}
    >
      {props.children}
      {side ? (
        // Where the row dropped would land: a rule above or below this one.
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-0 left-0 z-[7] h-0.5 bg-primary",
            side === "before" ? "top-0" : "bottom-0",
          )}
        />
      ) : null}
    </div>
  );
}

/** The grid's rows, as one list to move rows within. */
const GRID_LIST = "grid";

/** A locked or signed row, which keeps its place. */
function isFixed(row: RowItem): boolean {
  return row.ag_status === "locked" || row.ag_status === "signed";
}

/**
 * A row's gutter. Where rows move by hand, it is what one drags the row by;
 * the keyboard moves it from the row's menu.
 */
function RowGutter(props: {
  rowId: string | undefined;
  label: string;
  slot: ListSlot | undefined;
  className: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  const movable = props.slot !== undefined && props.rowId !== undefined;
  const { dragProps, isDragging } = useRowDrag(
    props.rowId ?? "",
    props.label,
    movable,
    props.slot,
  );
  return (
    <div
      role="rowheader"
      aria-colindex={1}
      // Only the pointer's drag: the row's menu moves it by keyboard.
      {...(movable
        ? {
            draggable: dragProps.draggable,
            onDragStart: dragProps.onDragStart,
            onDrag: dragProps.onDrag,
            onDragEnd: dragProps.onDragEnd,
          }
        : {})}
      className={cn(
        props.className,
        movable && "cursor-grab",
        isDragging && "opacity-50",
      )}
      style={props.style}
    >
      {props.children}
    </div>
  );
}

/**
 * The context menu's items. They mount when the menu opens, and read the
 * selection then: the grid itself does not re-render when it moves.
 */
function GridMenuItems(props: {
  selection: GridSelection;
  rowAtPosition: (position: number) => RowItem | undefined;
  canAdd: boolean;
  canDelete: boolean;
  onInsertBeside: ((place: RowPlace) => void) | undefined;
  onMove:
    | ((rowId: string, place: RowPlace, back: RowPlace | null) => void)
    | undefined;
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const copy = useCopy();
  const table = useTable();
  const { active } = useSelectionState(props.selection);
  const row = active ? props.rowAtPosition(active.r) : undefined;
  const above = active ? props.rowAtPosition(active.r - 1) : undefined;
  const below = active ? props.rowAtPosition(active.r + 1) : undefined;
  const back = placeBetween(above?.id, below?.id);
  const onInsertBeside = props.canAdd ? props.onInsertBeside : undefined;
  const onMove = row && !isFixed(row) ? props.onMove : undefined;
  return (
    <>
      {row ? (
        <ContextMenuItem onSelect={() => table.openRecord(row.id)}>
          <Expand className="h-4 w-4" aria-hidden />
          {t`Expand row`}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onSelect={props.onCopy}>
        <Copy className="h-4 w-4" aria-hidden />
        {t`Copy`}
      </ContextMenuItem>
      {row ? (
        <ContextMenuItem
          onSelect={() =>
            copy(
              `${window.location.origin}${window.location.pathname}?row=${row.id}`,
              t`Link copied`,
            )
          }
        >
          <LinkIcon className="h-4 w-4" aria-hidden />
          {t`Copy row link`}
        </ContextMenuItem>
      ) : null}
      {row && (onInsertBeside || onMove) ? <ContextMenuSeparator /> : null}
      {row && onInsertBeside ? (
        <>
          <ContextMenuItem onSelect={() => onInsertBeside({ before: row.id })}>
            <BetweenHorizontalStart className="h-4 w-4" aria-hidden />
            {t`Insert a row above`}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onInsertBeside({ after: row.id })}>
            <BetweenHorizontalEnd className="h-4 w-4" aria-hidden />
            {t`Insert a row below`}
          </ContextMenuItem>
        </>
      ) : null}
      {row && onMove && above ? (
        <ContextMenuItem
          onSelect={() => onMove(row.id, { before: above.id }, back)}
        >
          <ArrowUp className="h-4 w-4" aria-hidden />
          {t`Move the row up`}
        </ContextMenuItem>
      ) : null}
      {row && onMove && below ? (
        <ContextMenuItem
          onSelect={() => onMove(row.id, { after: below.id }, back)}
        >
          <ArrowDown className="h-4 w-4" aria-hidden />
          {t`Move the row down`}
        </ContextMenuItem>
      ) : null}
      {props.canAdd || props.canDelete ? <ContextMenuSeparator /> : null}
      {props.canAdd ? (
        <ContextMenuItem onSelect={props.onDuplicate}>
          <CopyPlus className="h-4 w-4" aria-hidden />
          {t`Duplicate`}
        </ContextMenuItem>
      ) : null}
      {props.canDelete ? (
        <ContextMenuItem danger onSelect={props.onDelete}>
          <Trash2 className="h-4 w-4" aria-hidden />
          {t`Delete rows`}
        </ContextMenuItem>
      ) : null}
    </>
  );
}
