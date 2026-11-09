import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Checkbox,
} from "@anygriddb/ui";
import {
  ArrowDownAZ,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpZA,
  ChevronDown,
  Copy,
  EyeOff,
  Filter,
  Group,
  Pencil,
  Pin,
  Plus,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { isWritableType } from "@anygriddb/core";
import { useRef, useState } from "react";
import type { CatalogColumn } from "../../lib/types";
import { FieldIcon } from "../fields/field-meta";
import { distinctLimits, useLimitText } from "../../lib/limits";
import { useLingui } from "@lingui/react/macro";

/**
 * A field the client's engine computes differently: the sentence shows on
 * hover, and a screen reader reads it with the header.
 */
function LimitMark(props: { text: string }) {
  return (
    <span role="img" aria-label={props.text} title={props.text}>
      <TriangleAlert className="h-3 w-3 shrink-0 text-amber-600" aria-hidden />
    </span>
  );
}

export function GridHeader(props: {
  columns: readonly CatalogColumn[];
  widths: readonly number[];
  offsets: readonly number[];
  frozenCount: number;
  virtualColumns: readonly number[];
  padStart: number;
  width: number;
  canManage: boolean;
  allChecked: boolean;
  onToggleAll: (value: boolean) => void;
  onResize: (column: string, width: number) => void;
  onReorder: (from: string, to: string) => void;
  onAddField: () => void;
  onEditField: (column: CatalogColumn) => void;
  onAction: (action: string, column: CatalogColumn, index: number) => void;
}) {
  const { t } = useLingui();
  const limitText = useLimitText();
  const limitsText = (column: CatalogColumn) =>
    distinctLimits(column.limits).map(limitText).join(" ");
  const [resizing, setResizing] = useState<{
    name: string;
    width: number;
  } | null>(null);
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  function header(index: number) {
    const column = props.columns[index];
    if (!column) return null;
    const frozen = index < props.frozenCount;
    const width =
      resizing?.name === column.name
        ? resizing.width
        : (props.widths[index] ?? 180);
    return (
      <div
        key={column.name}
        role="columnheader"
        aria-colindex={index + 2}
        draggable
        onDragStart={(event) => {
          dragged.current = column.name;
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (dragged.current && dragged.current !== column.name) {
            event.preventDefault();
            setOver(column.name);
          }
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(event) => {
          event.preventDefault();
          if (dragged.current && dragged.current !== column.name)
            props.onReorder(dragged.current, column.name);
          dragged.current = null;
          setOver(null);
        }}
        className={cn(
          "group/header relative flex shrink-0 items-center gap-1.5 border-r border-b border-strong-border bg-muted px-2 text-xs font-medium",
          frozen && "sticky z-[7]",
          over === column.name && "border-l-2 border-l-primary",
        )}
        style={{
          width,
          height: "100%",
          left: frozen ? props.offsets[index] : undefined,
        }}
      >
        <FieldIcon fieldType={column.fieldType} />
        {/* The full label and the description, for a truncated header. */}
        <span
          className="min-w-0 flex-1 truncate"
          title={column.description || column.label}
        >
          {column.label}
        </span>
        {column.isPrimary ? (
          <Star
            className="h-3 w-3 shrink-0 fill-current text-amber-500"
            aria-label={t`Primary field`}
          />
        ) : null}
        {column.requireReason ? (
          <span title={t`Reason required`}>*</span>
        ) : null}
        {column.limits.length > 0 ? (
          <LimitMark text={limitsText(column)} />
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t`${{ name: column.label }} field menu`}
            className="rounded p-0.5 opacity-0 group-hover/header:opacity-100 focus:opacity-100 hover:bg-card"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {props.canManage ? (
              <>
                <DropdownMenuItem onSelect={() => props.onEditField(column)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  {t`Edit field`}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => props.onAction("insert-left", column, index)}
                >
                  <ArrowLeftToLine className="h-4 w-4" aria-hidden />
                  {t`Insert left`}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => props.onAction("insert-right", column, index)}
                >
                  <ArrowRightToLine className="h-4 w-4" aria-hidden />
                  {t`Insert right`}
                </DropdownMenuItem>
                {isWritableType(column.fieldType) ||
                column.fieldType === "formula" ? (
                  <DropdownMenuItem
                    onSelect={() => props.onAction("duplicate", column, index)}
                  >
                    <Copy className="h-4 w-4" aria-hidden />
                    {t`Duplicate field`}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              onSelect={() => props.onAction("sort-asc", column, index)}
            >
              <ArrowDownAZ className="h-4 w-4" aria-hidden />
              {t`Sort A → Z`}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => props.onAction("sort-desc", column, index)}
            >
              <ArrowUpZA className="h-4 w-4" aria-hidden />
              {t`Sort Z → A`}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => props.onAction("filter", column, index)}
            >
              <Filter className="h-4 w-4" aria-hidden />
              {t`Filter by this field`}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => props.onAction("group", column, index)}
            >
              <Group className="h-4 w-4" aria-hidden />
              {t`Group by this field`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => props.onAction("freeze", column, index)}
            >
              <Pin className="h-4 w-4" aria-hidden />
              {t`Freeze up to here`}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => props.onAction("hide", column, index)}
            >
              <EyeOff className="h-4 w-4" aria-hidden />
              {t`Hide`}
            </DropdownMenuItem>
            {props.canManage ? (
              <>
                {!column.isPrimary ? (
                  <DropdownMenuItem
                    onSelect={() => props.onAction("primary", column, index)}
                  >
                    <Star className="h-4 w-4" aria-hidden />
                    {t`Set as primary field`}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  danger
                  onSelect={() => props.onAction("delete", column, index)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t`Delete field`}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={t`Resize`}
          className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-primary/40"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const startX = event.clientX;
            const startWidth = width;
            const onMove = (move: PointerEvent) => {
              setResizing({
                name: column.name,
                width: Math.max(
                  60,
                  Math.min(1200, startWidth + move.clientX - startX),
                ),
              });
            };
            const onUp = (up: PointerEvent) => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              const next = Math.max(
                60,
                Math.min(1200, startWidth + up.clientX - startX),
              );
              setResizing(null);
              if (next !== startWidth)
                props.onResize(column.name, Math.round(next));
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
        />
      </div>
    );
  }

  return (
    <div
      role="row"
      aria-rowindex={1}
      className="sticky top-0 z-[8] flex"
      style={{ width: props.width, height: 34 }}
    >
      <div
        role="columnheader"
        aria-colindex={1}
        className="sticky left-0 z-[9] flex shrink-0 items-center border-r border-b border-strong-border bg-muted px-1.5"
        style={{ width: 72 }}
      >
        <Checkbox
          aria-label={t`Select all`}
          className="h-3.5 w-3.5"
          checked={props.allChecked}
          onChange={(event) => props.onToggleAll(event.target.checked)}
        />
      </div>
      {Array.from({ length: props.frozenCount }, (_, index) => header(index))}
      <div aria-hidden className="shrink-0" style={{ width: props.padStart }} />
      {props.virtualColumns.map((index) => header(index))}
      {props.canManage ? (
        <div
          role="columnheader"
          aria-colindex={props.columns.length + 2}
          className="flex w-12 shrink-0 border-b border-strong-border bg-muted"
        >
          <button
            type="button"
            aria-label={t`Add a field`}
            title={t`Add a field`}
            className="flex h-full w-full items-center justify-center hover:bg-card"
            onClick={props.onAddField}
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
