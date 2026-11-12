import {
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "@anygriddb/ui";
import { GUTTER, marginColumn } from "./margin-column";
import {
  ArrowDownAZ,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpZA,
  Check,
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
import { isPrimaryType, isWritableType } from "@anygriddb/core";
import { useRef, useState } from "react";
import type { CatalogColumn } from "../../lib/types";
import { FieldIcon } from "../fields/field-meta";
import { ResizeHandle } from "../shell/resize-handle";
import { distinctLimits, useLimitText } from "../../lib/limits";
import { useLingui } from "@lingui/react/macro";

/**
 * A field the client's engine computes differently: the sentence shows on
 * hover, and a screen reader reads it with the header.
 */
function LimitMark(props: { text: string }) {
  return (
    <span role="img" aria-label={props.text} title={props.text}>
      <TriangleAlert className="h-3 w-3 shrink-0 text-warning" aria-hidden />
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
  /** How many loaded rows the header checkbox selects (not the whole view). */
  loadedCount: number;
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
          "group/header relative flex shrink-0 items-center gap-1.5 border-r border-b border-r-rule border-b-strong-border bg-head px-2 text-[13px] font-medium text-muted-foreground",
          frozen && "sticky z-[7]",
          index === marginColumn(props.frozenCount) &&
            "border-r-2 border-r-margin",
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
          className={cn(
            "min-w-0 flex-1 truncate",
            // The primary field is the one written in full ink.
            column.isPrimary && "text-foreground",
          )}
          title={column.description || column.label}
        >
          {column.label}
          {column.isPrimary ? (
            <span className="sr-only">, {t`Primary field`}</span>
          ) : null}
        </span>
        {column.required ? (
          <>
            <span className="text-danger" title={t`Value required`} aria-hidden>
              *
            </span>
            <span className="sr-only">, {t`Value required`}</span>
          </>
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
              {index === marginColumn(props.frozenCount) ? (
                t`Unfreeze columns`
              ) : (
                <>
                  {t`Freeze up to here`}
                  {index < props.frozenCount ? (
                    <Check className="ml-auto h-4 w-4" aria-hidden />
                  ) : null}
                </>
              )}
            </DropdownMenuItem>
            {column.isPrimary ? null : (
              <DropdownMenuItem
                onSelect={() => props.onAction("hide", column, index)}
              >
                <EyeOff className="h-4 w-4" aria-hidden />
                {t`Hide`}
              </DropdownMenuItem>
            )}
            {props.canManage ? (
              <>
                {!column.isPrimary && isPrimaryType(column.fieldType) ? (
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
        <ResizeHandle
          width={width}
          bounds={{ min: 60, max: 1200 }}
          label={t`Resize`}
          onResize={(next, phase) => {
            if (phase === "move") {
              setResizing({ name: column.name, width: next });
              return;
            }
            setResizing(null);
            if (next !== (props.widths[index] ?? 180)) {
              props.onResize(column.name, next);
            }
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
      style={{ width: props.width, height: 32 }}
    >
      <div
        role="columnheader"
        aria-colindex={1}
        className={cn(
          "sticky left-0 z-[9] flex shrink-0 items-center border-r border-b border-r-rule border-b-strong-border bg-head px-1.5",
          marginColumn(props.frozenCount) === -1 &&
            "border-r-2 border-r-margin",
        )}
        style={{ width: GUTTER }}
      >
        <Checkbox
          aria-label={
            props.loadedCount > 0
              ? t`Select ${{ count: props.loadedCount }} loaded rows`
              : t`Select loaded rows`
          }
          title={
            props.loadedCount > 0
              ? t`Selects the ${{ count: props.loadedCount }} rows already loaded`
              : t`Select loaded rows`
          }
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
          className="flex w-12 shrink-0 border-b border-strong-border bg-head"
        >
          <Tooltip content={t`Add a field`} side="bottom">
            <button
              type="button"
              aria-label={t`Add a field`}
              className="flex h-full w-full items-center justify-center hover:bg-card"
              onClick={props.onAddField}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
