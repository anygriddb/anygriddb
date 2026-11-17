import { MAX_GROUPS } from "@anygriddb/core";
import { Checkbox, cn } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Expand,
  MessageSquare,
  Plus,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { useRowDrag, useRowPlaceDrop, type ListSlot } from "../../lib/drag";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import type { RowPlace } from "../../lib/row-place";
import type { RowItem } from "../../lib/types";
import type { GridItem } from "./group-layout";
import { GUTTER, marginColumn } from "./margin-column";
import { type GridSelection, useEditingRow } from "./selection";

/** The grid's rows, as one list to move rows within. */
export const GRID_LIST = "grid";

/** A locked or signed row, which keeps its place. */
export function isFixed(row: RowItem): boolean {
  return row.ag_status === "locked" || row.ag_status === "signed";
}

/** Where a line of the grid is drawn, and how wide the sheet is. */
type Line = { top: number; height: number; width: number };

/**
 * A group's header: its value, how many rows it holds, and whether it is
 * folded. A group of the first level also folds or opens them all.
 */
export function GridGroupRow(props: {
  item: Extract<GridItem, { type: "group" }>;
  line: Line;
  /** How many columns the line spans: the fields and the row header. */
  span: number;
  folded: boolean;
  onFold: () => void;
  allFolded: boolean;
  onFoldAll: () => void;
}) {
  const { t } = useLingui();
  const { item, line, folded } = props;
  return (
    <div
      role="row"
      className="group/group absolute left-0 flex items-center gap-2 border-b border-rule bg-head px-2 text-sm font-medium"
      style={{
        top: line.top,
        height: line.height,
        width: line.width,
        paddingLeft: 8 + item.depth * 20,
      }}
    >
      <div role="gridcell" aria-colspan={props.span} className="contents">
        {/* Named by what it shows; folded or not, it says. */}
        <button
          type="button"
          aria-expanded={!folded}
          className="sticky left-2 flex items-center gap-2"
          onClick={props.onFold}
        >
          {folded ? (
            <ChevronRight className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden />
          )}
          {item.color ? (
            <span className={`opt-${item.color} rounded-full px-2 text-xs`}>
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
            onClick={props.onFoldAll}
          >
            {props.allFolded ? t`Expand all` : t`Collapse all`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Says that the view has more groups than the grid shows. */
export function GridLimitRow(props: { line: Line; span: number }) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const limit = formatNumber(MAX_GROUPS, locale);
  return (
    <div
      role="row"
      className="absolute left-0 flex items-center border-b border-rule px-3 text-[13px] text-muted-foreground"
      style={{
        top: props.line.top,
        height: props.line.height,
        width: props.line.width,
      }}
    >
      <div role="gridcell" aria-colspan={props.span} className="sticky left-3">
        {t`The first ${limit} groups are shown: filter the view to see the others.`}
      </div>
    </div>
  );
}

/** The grid's last line, which adds a row. */
export function GridAddRow(props: {
  line: Line;
  span: number;
  /** Up to the end of the last field: the line is as wide as the sheet. */
  sheetWidth: number;
  frozenCount: number;
  onAdd: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      role="row"
      className="absolute left-0 flex"
      style={{
        top: props.line.top,
        height: props.line.height,
        width: props.line.width,
      }}
    >
      <div role="gridcell" aria-colspan={props.span} className="contents">
        <button
          type="button"
          className="group/add flex h-full items-center border-b border-rule text-[13px] text-muted-foreground hover:text-foreground"
          style={{ width: props.sheetWidth }}
          onClick={props.onAdd}
        >
          {/* The gutter's share of the row: the plus sits where the numbers do. */}
          <span
            className={cn(
              "sticky left-0 flex h-full shrink-0 items-center justify-end border-r border-rule bg-head px-2 group-hover/add:bg-muted",
              marginColumn(props.frozenCount) === -1 &&
                "border-r-2 border-r-margin",
            )}
            style={{ width: GUTTER }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="px-2 group-hover/add:bg-muted">{t`Add a row`}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * A row of the table: its gutter (its rank in the view, the box that
 * ticks it, what opens it, its comments, its lock), then its cells. A
 * right click outside the range makes it the active row, so that the menu
 * acts on the row under the pointer.
 */
export function GridDataRow(props: {
  selection: GridSelection;
  /** The row, once read. */
  row: RowItem | undefined;
  /** Its place in the view, from 0. */
  index: number;
  /** Its place among the rows shown, folded groups aside. */
  position: number;
  line: Line;
  rowHeight: number;
  frozenCount: number;
  /** The colour the view gives it, if any. */
  tint: string | undefined;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  /** How many comments it has. */
  comments: number;
  onOpen: () => void;
  /** Where it stands among rows moved by hand; unset where they are not. */
  slot: ListSlot | undefined;
  onPlace: (rowId: string, place: RowPlace, from: number | undefined) => void;
  /** Its cells. */
  children: ReactNode;
}) {
  const { t } = useLingui();
  const { row, index, position, selection, checked, comments } = props;
  const slot = row ? props.slot : undefined;
  return (
    <EditingRow
      selection={selection}
      position={position}
      rowIndex={index + 2}
      className="group/row absolute left-0 flex"
      style={{
        top: props.line.top,
        height: props.line.height,
        width: props.line.width,
      }}
      drop={
        slot && row
          ? { ...slot, rowId: row.id, onPlace: props.onPlace }
          : undefined
      }
      onContextMenu={() => {
        const range = selection.getRange();
        if (!range || position < range.r1 || position > range.r2) {
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
        label={t`Row ${{ number: String(index + 1) }}`}
        // A locked or signed row stays where it is; others
        // can still be put beside it.
        slot={row && isFixed(row) ? undefined : slot}
        className={cn(
          "sticky left-0 z-[6] flex shrink-0 items-center gap-1.5 border-r border-b border-rule bg-head px-1.5 font-mono text-xs text-muted-foreground",
          marginColumn(props.frozenCount) === -1 &&
            "border-r-2 border-r-margin",
          props.tint && `row-tint-${props.tint}`,
        )}
        style={{ width: GUTTER, height: props.rowHeight }}
      >
        <Checkbox
          aria-label={t`Select row ${{ index: index + 1 }}`}
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            !checked && "opacity-0 group-hover/row:opacity-100",
          )}
          checked={checked}
          onChange={(event) => {
            if (row) props.onCheck(event.target.checked);
          }}
        />
        <span
          className={cn(
            "flex-1 text-right tabular-nums",
            checked ? "hidden" : "group-hover/row:hidden",
          )}
        >
          {/* Its rank in the view, as a spreadsheet numbers
              its lines: the row's own number, which never
              changes, is the record panel's. */}
          {index + 1}
        </span>
        {row ? (
          <button
            type="button"
            aria-label={t`Expand row`}
            className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-foreground hover:bg-muted group-hover/row:inline-flex"
            onClick={props.onOpen}
          >
            <Expand className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        {row && comments > 0 ? (
          <button
            type="button"
            className="inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded px-0.5 text-[10px] hover:bg-muted group-hover/row:hidden"
            aria-label={plural(props.comments, {
              one: `# comment`,
              other: `# comments`,
            })}
            onClick={props.onOpen}
          >
            <MessageSquare className="h-3 w-3" aria-hidden />
            {comments}
          </button>
        ) : null}
        {row && isFixed(row) ? (
          <span title={String(row.ag_status)} className="text-[10px]">
            🔒
          </span>
        ) : null}
        {row?.drift ? (
          <span
            role="img"
            aria-label={t`Changed outside AnyGridDB since it was locked`}
            title={t`Changed outside AnyGridDB since it was locked`}
          >
            <AlertTriangle className="h-3.5 w-3.5 text-danger" aria-hidden />
          </span>
        ) : null}
      </RowGutter>
      {props.children}
    </EditingRow>
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
