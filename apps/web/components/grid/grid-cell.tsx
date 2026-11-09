import { rowError } from "@anygriddb/core";
import { cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cellDisplay } from "../../lib/format";
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

export type EditDirection = "down" | "right" | "left" | undefined;

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
  const flags = useCellFlags(selection, position, columnIndex);
  const cell = { r: position, c: columnIndex };
  const selected = (flags & SELECTED) !== 0;
  const active = (flags & ACTIVE) !== 0;
  const editing = (flags & EDITING) !== 0 && row !== undefined;
  const editable = isEditableColumn(column) || isEditableLink(column);
  const value = row ? row[column.name as keyof RowItem] : undefined;
  const error = row ? rowError(row, column.name) : null;
  const { t } = useLingui();
  return (
    <div
      id={cellId(props.grid, position, columnIndex)}
      role="gridcell"
      // The row header is column 1.
      aria-colindex={columnIndex + 2}
      aria-selected={selected}
      aria-readonly={!props.canEdit || !editable}
      // While it is edited, the editor inside names itself.
      aria-label={
        editing
          ? undefined
          : row
            ? `${column.label}: ${
                error === null
                  ? cellDisplay(value, column, table.locale, table.people)
                  : t`error, ${error}`
              }`
            : column.label
      }
      data-column={column.name}
      className={cn(
        "relative flex shrink-0 items-start overflow-visible border-r border-b border-border px-2 py-1.5 text-sm",
        props.left !== undefined ? "sticky z-[5] bg-card" : "bg-card",
        (selected || (flags & FILLING) !== 0) && "bg-selection",
        column.kind === "number" && "justify-end",
        !editable && "text-muted-foreground",
      )}
      style={{ width: props.width, height: props.height, left: props.left }}
      onPointerDown={(event) => props.onPointerDown(event, cell)}
      onPointerEnter={() => props.onPointerEnter(cell)}
      onDoubleClick={() => props.onEdit(cell)}
    >
      {row ? (
        <div
          className={cn(
            "flex min-w-0 flex-1 overflow-hidden",
            props.wrap ? "items-start" : "items-center",
          )}
        >
          {column.fieldType === "button" ? (
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
        <span className="pointer-events-none absolute inset-0 z-10 border-2 border-primary" />
      ) : null}
      {props.peer && !active ? (
        <span className="pointer-events-none absolute inset-0 z-10 border-2 border-dashed border-purple-500">
          <span className="absolute -top-4 left-0 rounded bg-purple-500 px-1 text-[10px] text-white">
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
          onDone={(direction) => props.onEditDone(cell, direction)}
        />
      ) : null}
    </div>
  );
}
