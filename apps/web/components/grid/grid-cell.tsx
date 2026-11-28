import { rowError, rowHidden } from "@anygriddb/core";
import { cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { EyeOff } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cellDisplay } from "../../lib/format";
import { rowStateWord } from "../fields/use-row-states";
import type { Presence } from "../../lib/realtime";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { ButtonCell } from "../fields/button-cell";
import { CellEditor } from "../fields/cell-editor";
import { CellValueView } from "../fields/cell-value";
import { useTable } from "../table/table-context";
import { isEditableColumn, isEditableLink } from "./grid-clipboard";
import {
  ACTIVE,
  CORNER,
  EDITING,
  FILLING,
  SELECTED,
  cellId,
  useCellFlags,
  type Cell,
  type GridSelection,
} from "./selection";

type EditDirection = "down" | "right" | "left" | undefined;

/**
 * One cell of the ARIA grid. It reads its own selection flags, so a move
 * of the selection re-renders this cell only when its look changes.
 */
export function GridCell(props: {
  selection: GridSelection;
  /** Prefix of cell ids, unique to the grid. */
  grid: string;
  row: RowItem | undefined;
  position: number;
  columnIndex: number;
  column: CatalogColumn;
  width: number;
  /** Offset of a frozen column; undefined for one that scrolls. */
  left: number | undefined;
  /**
   * Where a cell that scrolled out of the columns drawn stands in its row:
   * it stays while it is edited, or its editor would close.
   */
  heldAt?: number;
  /** Whether its right rule is the ledger's margin (`marginColumn`). */
  margin: boolean;
  height: number;
  wrap: boolean;
  canEdit: boolean;
  peer: Presence | undefined;
  onPointerDown: (event: ReactPointerEvent, cell: Cell) => void;
  onPointerEnter: (cell: Cell) => void;
  onEdit: (cell: Cell) => void;
  onEditDone: (cell: Cell, direction: EditDirection) => void;
  onFillStart: () => void;
}) {
  const table = useTable();
  const { row, column, position, columnIndex, selection } = props;
  const flags = useCellFlags(
    selection,
    position,
    columnIndex,
    row?.id,
    column.name,
  );
  const cell = { r: position, c: columnIndex };
  const selected = (flags & SELECTED) !== 0;
  const active = (flags & ACTIVE) !== 0;
  const editing = (flags & EDITING) !== 0 && row !== undefined;
  const editable = isEditableColumn(column) || isEditableLink(column);
  const value = row ? row[column.name as keyof RowItem] : undefined;
  const error = row ? rowError(row, column.name) : null;
  // A field the reader sees on other rows and not on this one (ADR 0144).
  const hiddenHere = row ? rowHidden(row, column.name) : false;
  const { t, i18n } = useLingui();
  return (
    <div // NOSONAR: the grid holds the focus and names the active cell (aria-activedescendant)
      id={cellId(props.grid, position, columnIndex)}
      role="gridcell"
      // The row header is column 1.
      aria-colindex={columnIndex + 2}
      aria-selected={selected}
      aria-readonly={!props.canEdit || !editable || hiddenHere}
      // While it is edited, the editor inside names itself.
      aria-label={
        editing
          ? undefined
          : row
            ? `${column.label}: ${
                hiddenHere
                  ? t`hidden on this row`
                  : error === null
                    ? column.fieldType === "row_state" &&
                      typeof value === "string"
                      ? rowStateWord(table.states, value, i18n)
                      : cellDisplay(value, column, table.locale, table.people)
                    : t`error, ${error}`
              }`
            : column.label
      }
      data-column={column.name}
      className={cn(
        "relative flex shrink-0 items-start overflow-visible border-r border-b border-rule px-2 py-1.5 text-[13px] leading-5",
        // While editing, sit above later rows so the panel receives clicks
        // (virtualized rows paint in document order otherwise).
        editing
          ? cn("z-50 bg-card", props.left !== undefined && "sticky")
          : props.left !== undefined
            ? "sticky z-[5] bg-card"
            : "bg-card",
        props.margin && "border-r-2 border-r-margin",
        (selected || (flags & FILLING) !== 0) && "bg-selection",
        column.kind === "number" && "justify-end",
        !editable && "text-muted-foreground",
      )}
      style={{
        width: props.width,
        height: props.height,
        left: props.heldAt ?? props.left,
        ...(props.heldAt === undefined ? {} : { position: "absolute" }),
      }}
      onPointerDown={(event) => props.onPointerDown(event, cell)}
      onPointerEnter={() => props.onPointerEnter(cell)}
      onDoubleClick={() => {
        if (!hiddenHere) props.onEdit(cell);
      }}
    >
      {row ? (
        <div
          className={cn(
            "flex min-w-0 flex-1 overflow-hidden",
            props.wrap ? "items-start" : "items-center",
          )}
        >
          {hiddenHere ? (
            <HiddenHere />
          ) : column.fieldType === "button" ? (
            <ButtonCell column={column} row={row} />
          ) : (
            <CellValueView
              value={value}
              column={column}
              locale={table.locale}
              people={table.people}
              search={table.search}
              wrap={props.wrap}
              error={error}
            />
          )}
        </div>
      ) : (
        <span className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      )}
      {active ? (
        <span
          className={cn(
            "pointer-events-none absolute inset-0 z-10 border-2",
            table.saveStatus === "saving"
              ? "border-primary/60"
              : table.saveStatus === "error"
                ? "border-danger"
                : "border-primary",
          )}
        />
      ) : null}
      {active && table.saveStatus === "saving" ? (
        <span
          role="status"
          className="pointer-events-none absolute top-0.5 right-0.5 z-20 h-1.5 w-1.5 rounded-full bg-primary"
          aria-label={t`Saving…`}
        />
      ) : null}
      {props.peer && !active ? (
        // A colleague's cell: the purple of the options' palette, its
        // label at AA contrast in both themes.
        <span className="pointer-events-none absolute inset-0 z-10 border-2 border-dashed border-[var(--ag-series-7)]">
          <span className="opt-purple absolute -top-4 left-0 rounded-sm px-1 text-[10px] leading-4 font-medium">
            {props.peer.name}
          </span>
        </span>
      ) : null}
      {active && (flags & CORNER) !== 0 && props.canEdit && !editing ? (
        <span
          role="presentation"
          className="absolute -right-1 -bottom-1 z-20 h-2.5 w-2.5 cursor-ns-resize border border-card bg-primary"
          onPointerDown={(event) => {
            event.stopPropagation();
            props.onFillStart();
          }}
        />
      ) : null}
      {editing ? (
        <CellEditor
          column={column}
          row={row}
          initialText={selection.getState().editing?.text}
          onDraft={(read) => selection.holdDraft(read)}
          onDone={(direction) => props.onEditDone(cell, direction)}
        />
      ) : null}
    </div>
  );
}

/** What a cell shows of a field hidden on its row (ADR 0144). */
function HiddenHere() {
  const { t } = useLingui();
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <EyeOff className="h-3.5 w-3.5" aria-hidden />
      {t`Hidden`}
    </span>
  );
}
