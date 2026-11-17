import { ContextMenuItem, ContextMenuSeparator } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import {
  ArrowDown,
  ArrowUp,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  Copy,
  CopyPlus,
  Expand,
  Link as LinkIcon,
  Trash2,
} from "lucide-react";
import { useCopy } from "../../lib/clipboard";
import { placeBetween, type RowPlace } from "../../lib/row-place";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import { isFixed } from "./grid-rows";
import { type GridSelection, useSelectionState } from "./selection";

/**
 * The context menu's items. They mount when the menu opens, and read the
 * selection then: the grid itself does not re-render when it moves.
 */
export function GridMenuItems(props: {
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
