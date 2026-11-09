import { cellText } from "@anygriddb/core";
import { RowsError } from "./rows-error";

import {
  Checkbox,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Spinner,
} from "@anygriddb/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
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
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import type { Presence } from "../../lib/realtime";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { useErrorText } from "../../lib/errors";
import { useTRPC } from "../../lib/trpc";
import { opensPanel } from "../fields/cell-editor";
import { optionsOf } from "../fields/cell-value";
import { DEFAULT_WIDTH } from "../fields/field-meta";
import { useTable, type CellValue } from "../table/table-context";
import { GridFooter } from "./grid-footer";
import { GridCell } from "./grid-cell";
import { GridHeader } from "./grid-header";
import { SelectionSummaryBar } from "./selection-summary";
import {
  cellId,
  GridSelection,
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
import type { RowsState } from "./use-rows";
import { useLingui } from "@lingui/react/macro";
import { plural } from "@lingui/core/macro";

export const ROW_HEIGHTS = {
  short: 34,
  medium: 56,
  tall: 88,
  extra: 128,
} as const;
const HEADER = 34;
const FOOTER = 32;
const GUTTER = 72;

type Item =
  | { type: "row"; index: number }
  | {
      type: "group";
      key: string;
      label: string;
      count: number;
      depth: number;
      color?: string;
    }
  | { type: "add" };

export type GridProps = {
  rows: RowsState;
  columns: readonly CatalogColumn[];
  widths: Readonly<Record<string, number>>;
  frozen: number;
  rowHeight: keyof typeof ROW_HEIGHTS;
  groupBy: ReadonlyArray<{ column: string; direction: "asc" | "desc" }>;
  colorColumn?: string;
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
  onUndo: () => void;
  onRedo: () => void;
  onResize: (column: string, width: number) => void;
  onReorder: (from: string, to: string) => void;
  onAggregate: (column: string, fn: string | null) => void;
  onAddField: (position?: number) => void;
  onEditField: (column: CatalogColumn) => void;
  onHeaderAction: (
    action: string,
    column: CatalogColumn,
    index: number,
  ) => void;
};

function groupKeyOf(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  )
    return "";
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object" && "label" in item
          ? String((item as { label: unknown }).label)
          : String(item),
      )
      .join(", ");
  }
  return cellText(value);
}

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
  // The selection lives outside React state: see selection.ts.
  const [selection] = useState(() => new GridSelection());
  const gridId = useId();
  const dragging = useRef(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rowHeight = ROW_HEIGHTS[props.rowHeight];
  const grouped = props.groupBy.length > 0;

  const widths = columns.map(
    (column) =>
      props.widths[column.name] ?? DEFAULT_WIDTH[column.fieldType] ?? 180,
  );
  const offsets: number[] = [];
  let running = GUTTER;
  for (const width of widths) {
    offsets.push(running);
    running += width;
  }
  const totalWidth = running + 120;
  const frozenCount = Math.min(frozen, columns.length);
  const frozenWidth = (offsets[frozenCount] ?? running) - GUTTER;

  const items: Item[] = useMemo(() => {
    const list: Item[] = [];
    if (!grouped) {
      for (let index = 0; index < rows.total; index += 1)
        list.push({ type: "row", index });
    } else {
      const loaded = rows.loadedRows();
      const levels = props.groupBy.map((group) =>
        columns.find((column) => column.name === group.column),
      );
      let previous: string[] = [];
      const counts = new Map<string, number>();
      loaded.forEach((row) => {
        const keys = levels.map((column) =>
          column ? groupKeyOf(row[column.name as keyof RowItem]) : "",
        );
        keys.forEach((_, depth) => {
          const path = keys.slice(0, depth + 1).join("\u0000");
          counts.set(path, (counts.get(path) ?? 0) + 1);
        });
      });
      loaded.forEach((row, index) => {
        const keys = levels.map((column) =>
          column ? groupKeyOf(row[column.name as keyof RowItem]) : "",
        );
        let hidden = false;
        for (let depth = 0; depth < keys.length; depth += 1) {
          const path = keys.slice(0, depth + 1).join("\u0000");
          const changed =
            keys.slice(0, depth + 1).join("\u0000") !==
            previous.slice(0, depth + 1).join("\u0000");
          if (changed && !hidden) {
            const column = levels[depth];
            const color =
              column &&
              (column.fieldType === "single_select" ||
                column.fieldType === "multi_select")
                ? optionsOf(column).find(
                    (option) => option.name === keys[depth],
                  )?.color
                : undefined;
            list.push({
              type: "group",
              key: path,
              label: keys[depth] ?? "",
              count: counts.get(path) ?? 0,
              depth,
              color,
            });
          }
          if (collapsed.has(path)) hidden = true;
        }
        previous = keys;
        if (!hidden) list.push({ type: "row", index });
      });
    }
    if (canAdd) list.push({ type: "add" });
    return list;
  }, [rows, grouped, props.groupBy, columns, collapsed, canAdd]);

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
        : items[index]?.type === "add"
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
  const firstIndex = virtualRows[0]?.index ?? 0;
  const lastIndex = virtualRows[virtualRows.length - 1]?.index ?? 0;
  useEffect(() => {
    if (grouped) return;
    rows.ensure(firstIndex, lastIndex);
  }, [firstIndex, lastIndex, rows, grouped]);

  const rowIndexOfItem = (item: Item | undefined): number | undefined =>
    item?.type === "row" ? item.index : undefined;
  const visibleRowIndexes = useMemo(
    () => items.flatMap((item) => (item.type === "row" ? [item.index] : [])),
    [items],
  );
  const rowAtPosition = (position: number): RowItem | undefined => {
    const index = visibleRowIndexes[position];
    return index === undefined ? undefined : rows.rowAt(index);
  };
  const positionOfRow = (index: number) => visibleRowIndexes.indexOf(index);

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
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) props.onRedo();
      else props.onUndo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      props.onRedo();
      return;
    }
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
    const loadedRows: RowItem[] = [];
    const needed = Math.max(matrix.length, range ? range.r2 - range.r1 + 1 : 1);
    for (let r = start.r; r < start.r + needed; r += 1) {
      const row = rowAtPosition(r);
      if (row) loadedRows[r - start.r] = row;
      else if (r < visibleRowIndexes.length) {
        toast.error(t`Scroll to load the rows before pasting`);
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

  const colorColumn = props.colorColumn
    ? columns.find((column) => column.name === props.colorColumn)
    : undefined;

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
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {checked.size > 0 ? (
        <div className="absolute top-1 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm shadow-lg">
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
                      className="group/group absolute left-0 flex items-center gap-2 border-b border-border bg-muted px-2 text-sm font-medium"
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
                        <button
                          type="button"
                          aria-expanded={!collapsed.has(item.key)}
                          aria-label={
                            collapsed.has(item.key) ? t`Expand` : t`Collapse`
                          }
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
                            <ChevronRight className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
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
                          className="flex h-full w-full items-center gap-2 border-b border-border px-3 text-sm text-muted-foreground hover:bg-muted"
                          onClick={() => void props.onAddRow()}
                        >
                          <Plus className="h-4 w-4" aria-hidden />
                          {t`Add a row`}
                        </button>
                      </div>
                    </div>
                  );
                }
                const position = positionOfRow(rowIndexOfItem(item) ?? -1);
                const row = rows.rowAt(item.index);
                const tint =
                  colorColumn && row
                    ? optionsOf(colorColumn).find((option) => {
                        const value = row[colorColumn.name as keyof RowItem];
                        return Array.isArray(value)
                          ? value[0] === option.name
                          : value === option.name;
                      })?.color
                    : undefined;
                return (
                  <div
                    key={row?.id ?? `r-${item.index}`}
                    role="row"
                    aria-rowindex={item.index + 2}
                    className="group/row absolute left-0 flex"
                    style={{ top, height: virtual.size, width: totalWidth }}
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
                    <div
                      role="rowheader"
                      aria-colindex={1}
                      className={cn(
                        "sticky left-0 z-[6] flex shrink-0 items-center gap-2 border-r border-b border-border bg-card px-1.5 text-xs text-muted-foreground",
                        tint && `row-tint-${tint}`,
                      )}
                      style={{ width: GUTTER, height: rowHeight }}
                    >
                      <Checkbox
                        aria-label={t`Select row ${{ index: item.index + 1 }}`}
                        className={cn(
                          "h-4 w-4 shrink-0",
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
                          "flex-1 tabular-nums",
                          checked.has(row?.id ?? "")
                            ? "hidden"
                            : "group-hover/row:hidden",
                        )}
                      >
                        {cellText(row?.ag_seq ?? item.index + 1)}
                      </span>
                      {row ? (
                        <button
                          type="button"
                          aria-label={t`Expand row`}
                          className="hidden h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-muted group-hover/row:inline-flex"
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
                    </div>
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
                  </div>
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
      <SelectionSummaryBar
        selection={selection}
        columns={columns}
        rowAt={rowAtPosition}
      />
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
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const copy = useCopy();
  const table = useTable();
  const { active } = useSelectionState(props.selection);
  const row = active ? props.rowAtPosition(active.r) : undefined;
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
