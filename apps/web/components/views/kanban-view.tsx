import { Checkbox, cn, DragHandle, OptionBadge } from "@anygriddb/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { useRowDrag, useRowDrop, useRowPlaceDrop } from "../../lib/drag";
import { placeBetween, type RowPlace } from "../../lib/row-place";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { optionsOf } from "../fields/cell-value";
import { useTable } from "../table/table-context";
import { kanbanStacks, stackPlaces } from "./kanban-stacks";
import {
  CardFields,
  CardFieldsPicker,
  cardColumns,
  ColumnPicker,
  useRowTitle,
  type ViewProps,
} from "./view-common";
import { useLingui } from "@lingui/react/macro";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";

function Card({
  row,
  stack,
  index,
  fields,
  draggable,
  titleColumn,
  tint,
  onPlace,
}: {
  row: RowItem;
  /** The stack the card is in, and its place in the view's order. */
  stack: string;
  index: number;
  fields: readonly CatalogColumn[];
  draggable: boolean;
  titleColumn?: string;
  tint?: string;
  /** A card dropped on this one: where it goes, and where it was. */
  onPlace?: (rowId: string, place: RowPlace, from: number | undefined) => void;
}) {
  const { t } = useLingui();
  const table = useTable();
  const title = useRowTitle(titleColumn);
  const name = title(row);
  const slot = { list: stack, index };
  const { dragProps, dragButtonProps, isDragging } = useRowDrag(
    row.id,
    name,
    draggable,
    slot,
  );
  const ref = useRef<HTMLDivElement>(null);
  const { dropProps, side } = useRowPlaceDrop(
    ref,
    { ...slot, rowId: row.id },
    (rowId, place, from) => onPlace?.(rowId, place, from),
    onPlace !== undefined,
  );
  return (
    <div ref={ref} {...(onPlace ? dropProps : {})} className="relative">
      {side ? (
        // Where the card dropped would land: in the gap above or below.
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-0 left-0 h-0.5 rounded-full bg-primary",
            side === "before" ? "-top-[5px]" : "-bottom-[5px]",
          )}
        />
      ) : null}
      <div
        {...dragProps}
        className={cn(
          "relative rounded-sm border border-border bg-card text-sm hover:border-strong-border",
          isDragging && "opacity-50",
          tint && `row-tint-${tint}`,
        )}
      >
        <button
          type="button"
          onClick={() => table.openRecord(row.id)}
          className="w-full cursor-pointer rounded-sm p-2.5 pr-7 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring"
        >
          <p className="truncate font-medium">{name}</p>
          <CardFields row={row} columns={fields} />
        </button>
        {draggable ? (
          <DragHandle
            {...dragButtonProps}
            label={t`Move ${name}`}
            className="absolute top-1.5 right-1"
          />
        ) : null}
      </div>
    </div>
  );
}

function Stack({
  id,
  label,
  color,
  start,
  count,
  rowAt,
  ensure,
  fields,
  canEdit,
  collapsed,
  titleColumn,
  tintOf,
  onToggle,
  onAdd,
  onMove,
  onPlace,
}: {
  id: string;
  label: string;
  color?: string;
  /** Where the stack's rows start in the view's grouped order. */
  start: number;
  /** The stack's rows, as the database counts them. */
  count: number;
  rowAt: (index: number) => RowItem | undefined;
  ensure: (start: number, end: number) => void;
  fields: readonly CatalogColumn[];
  canEdit: boolean;
  /** Folded to a narrow strip; cards can still be dropped on it. */
  collapsed: boolean;
  titleColumn?: string;
  tintOf?: (row: RowItem) => string | undefined;
  onToggle: () => void;
  onAdd: () => void;
  /** A card was dropped here: put row `rowId` in stack `stackId`. */
  onMove: (rowId: string, stackId: string) => void;
  /**
   * A card was dropped on another of stack `stackId`: put it there, beside
   * that card, and say where it was in this stack (`back`, for undo). Unset
   * where cards keep no order of their own.
   */
  onPlace?: (
    rowId: string,
    stackId: string,
    place: RowPlace,
    back: RowPlace | null,
  ) => void;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const ref = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useRowDrop(ref, (rowId) =>
    onMove(rowId, id),
  );
  // Every card of the stack has its place, read as it comes into view, and
  // is measured once drawn: its height follows its fields.
  // TanStack Virtual hands back a mutable instance, so the React Compiler
  // leaves this component as written; its manual memoization stays.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: collapsed ? 0 : count,
    getScrollElement: () => listRef.current,
    estimateSize: () => 88,
    overscan: 8,
    gap: 8,
    getItemKey: (index) => rowAt(start + index)?.id ?? `waiting-${index}`,
  });
  const cards = virtualizer.getVirtualItems();
  const first = start + (cards[0]?.index ?? 0);
  const last = start + (cards.at(-1)?.index ?? 0);
  const drawn = cards.length;
  useEffect(() => {
    if (drawn > 0) ensure(first, last);
  }, [ensure, first, last, drawn]);
  const name = label || t`No value`;
  const total = formatNumber(count, locale);
  if (collapsed) {
    return (
      <section
        ref={ref}
        {...dropProps}
        aria-label={name}
        className={cn(
          "flex w-10 shrink-0 flex-col items-center rounded-sm bg-muted/70 py-2",
          isDropTarget && "ring-2 ring-primary",
        )}
      >
        <button
          type="button"
          className="flex flex-1 flex-col items-center gap-2 rounded-md px-1 py-1 hover:bg-card"
          aria-expanded={false}
          aria-label={t`Expand column ${{ name: name }}`}
          onClick={onToggle}
        >
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">{total}</span>
          <span className="text-sm font-medium [writing-mode:vertical-rl]">
            {color ? <OptionBadge color={color}>{name}</OptionBadge> : name}
          </span>
        </button>
      </section>
    );
  }
  return (
    <section
      ref={ref}
      {...dropProps}
      aria-label={label || t`No value`}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-sm bg-muted/70 p-2",
        isDropTarget && "ring-2 ring-primary",
      )}
    >
      <header className="mb-2 flex items-center gap-2 px-1">
        {color ? (
          <OptionBadge color={color}>{label}</OptionBadge>
        ) : (
          <span className="text-sm font-medium">{name}</span>
        )}
        <span className="text-xs text-muted-foreground">{total}</span>
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
          aria-expanded
          aria-label={t`Collapse column ${{ name: name }}`}
          onClick={onToggle}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div ref={listRef} className="min-h-12 flex-1 overflow-y-auto">
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {cards.map((virtual) => {
            const row = rowAt(start + virtual.index);
            return (
              <div
                key={virtual.key}
                data-index={virtual.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{
                  transform: `translateY(${String(virtual.start)}px)`,
                }}
              >
                {row ? (
                  <Card
                    row={row}
                    stack={id}
                    index={start + virtual.index}
                    onPlace={
                      onPlace && canEdit
                        ? (rowId, place, from) =>
                            onPlace(
                              rowId,
                              id,
                              place,
                              from === undefined
                                ? null
                                : // Its neighbours in this stack only.
                                  placeBetween(
                                    from > start
                                      ? rowAt(from - 1)?.id
                                      : undefined,
                                    from < start + count - 1
                                      ? rowAt(from + 1)?.id
                                      : undefined,
                                  ),
                            )
                        : undefined
                    }
                    fields={fields}
                    titleColumn={titleColumn}
                    tint={tintOf?.(row)}
                    draggable={
                      canEdit &&
                      row.ag_status !== "locked" &&
                      row.ag_status !== "signed"
                    }
                  />
                ) : (
                  <div
                    aria-hidden
                    className="flex h-20 flex-col gap-2 rounded-sm border border-border bg-card p-2.5"
                  >
                    <span className="h-3 w-2/3 animate-pulse rounded-sm bg-muted" />
                    <span className="h-2.5 w-1/2 animate-pulse rounded-sm bg-muted" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {canEdit ? (
        <button
          type="button"
          onClick={onAdd}
          className="mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-card"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t`Add a card`}
        </button>
      ) : null}
    </section>
  );
}

export function KanbanView(props: ViewProps) {
  const { t } = useLingui();
  const table = useTable();
  const stackable = props.allColumns.filter(
    (column) => column.fieldType === "single_select",
  );
  const stackName =
    typeof props.config.stackColumn === "string"
      ? props.config.stackColumn
      : stackable[0]?.name;
  const stack = props.allColumns.find((column) => column.name === stackName);
  const exclude = stackName ? [stackName] : [];
  const fields = cardColumns(props.config, props.columns, exclude);
  const cardFields = Array.isArray(props.config.cardFields)
    ? (props.config.cardFields as string[])
    : undefined;
  const titleName =
    typeof props.config.titleColumn === "string"
      ? props.config.titleColumn
      : undefined;
  const titleChoices = props.columns.filter(
    (column) => column.fieldType !== "attachment",
  );
  const hideEmpty = props.config.hideEmptyStacks === true;
  const folded = new Set(
    Array.isArray(props.config.collapsedStacks)
      ? (props.config.collapsedStacks as string[])
      : [],
  );
  function toggle(id: string) {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onPatch({ collapsedStacks: next.size > 0 ? [...next] : null });
  }
  if (!stack) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`Add a single select field to arrange cards in columns.`}
      </p>
    );
  }
  const options = optionsOf(stack);
  const placed = stackPlaces(props.groups);
  const stacks = kanbanStacks(options, placed);
  function move(rowId: string, target: string) {
    if (!stack) return;
    const row = props.rows.find((item) => item.id === rowId);
    if (!row || (row[stack.name as keyof RowItem] ?? "") === target) return;
    void table.updateCells([
      { rowId, values: { [stack.name]: target || null } },
    ]);
  }
  const onMoveRows = props.onMoveRows;
  // A card dropped beside another: into that card's stack first, when it
  // came from another, then at its place there.
  async function place(
    rowId: string,
    target: string,
    to: RowPlace,
    back: RowPlace | null,
  ) {
    if (!stack || !onMoveRows) return;
    const row = props.rows.find((item) => item.id === rowId);
    if (row && (row[stack.name as keyof RowItem] ?? "") !== target) {
      await table.updateCells([
        { rowId, values: { [stack.name]: target || null } },
      ]);
    }
    await onMoveRows([rowId], to, back);
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-1.5">
        <ColumnPicker
          label={t`Columns by`}
          value={stack.name}
          columns={stackable}
          onChange={(value) => props.onPatch({ stackColumn: value })}
        />
        <ColumnPicker
          label={t`Card title`}
          value={titleName}
          columns={titleChoices}
          allowNone
          // Unset, a card is named by the row's primary field.
          noneLabel={t`Primary field`}
          onChange={(value) => props.onPatch({ titleColumn: value })}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={hideEmpty}
            onChange={(event) =>
              props.onPatch({
                hideEmptyStacks: event.target.checked ? true : null,
              })
            }
          />
          {t`Hide empty columns`}
        </label>
        <CardFieldsPicker
          columns={props.columns}
          exclude={exclude}
          value={cardFields}
          onChange={(next) => props.onPatch({ cardFields: next })}
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {stacks
          .filter((item) => !hideEmpty || (placed.get(item.id)?.count ?? 0) > 0)
          .map((item) => (
            <Stack
              key={item.id || "__empty"}
              id={item.id}
              label={item.label}
              color={item.color}
              start={placed.get(item.id)?.start ?? 0}
              count={placed.get(item.id)?.count ?? 0}
              rowAt={props.rowAt}
              ensure={props.ensure}
              fields={fields}
              canEdit={props.canEdit}
              collapsed={folded.has(item.id)}
              titleColumn={titleName}
              tintOf={props.tintOf}
              onToggle={() => toggle(item.id)}
              onAdd={() =>
                void props
                  .onCreate(item.id ? { [stack.name]: item.id } : {})
                  .then((id) => id && table.openRecord(id))
              }
              onMove={move}
              {...(onMoveRows
                ? {
                    onPlace: (
                      rowId: string,
                      target: string,
                      to: RowPlace,
                      back: RowPlace | null,
                    ) => void place(rowId, target, to, back),
                  }
                : {})}
            />
          ))}
      </div>
    </div>
  );
}
