import { cn } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import type { RowItem } from "../../lib/types";
import { drawnFields } from "./card-fields";
import { CellValueView } from "../fields/cell-value";
import { useTable } from "../table/table-context";
import {
  LIST_CEILING,
  listLines,
  parentColumn,
  parentColumns,
} from "./list-lines";
import {
  CardFieldsPicker,
  cardColumns,
  ColumnPicker,
  useRowTitle,
  type ViewProps,
} from "./view-common";

const LINE_ESTIMATE = 44;
/** How far each level sits from the one above it. */
const INDENT = 20;

/**
 * The rows one under another (ROADMAP #96): each under the row that a
 * link to the same table names, folded and unfolded by its arrow or from
 * the keyboard, as a tree is. Without such a link, a plain list.
 */
export function ListView(props: ViewProps) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const table = useTable();
  const titleName =
    typeof props.config.titleColumn === "string"
      ? props.config.titleColumn
      : undefined;
  const title = useRowTitle(titleName);
  const parents = parentColumns(props.allColumns, table.table.id);
  const parent = parentColumn(props.config, parents);
  // What a row is under shows by where it is drawn.
  const exclude = parent ? [parent] : [];
  const fields = cardColumns(props.config, props.columns, exclude);
  const cardFields = Array.isArray(props.config.cardFields)
    ? (props.config.cardFields as string[])
    : undefined;
  const titleChoices = props.columns.filter(
    (column) => column.fieldType !== "attachment",
  );

  // A row is placed among all the others: the view reads its rows, page
  // after page, up to the ceiling.
  const read = Math.min(props.total, LIST_CEILING);
  const { ensure } = props;
  useEffect(() => {
    if (read > 0) ensure(0, read - 1);
  }, [ensure, read]);

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const lines = useMemo(
    () => listLines(props.rows, parent, folded),
    [props.rows, parent, folded],
  );
  const toggle = (rowId: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual hands back a mutable instance, so the React Compiler
  // leaves this component as written; its manual memoization stays.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_ESTIMATE,
    overscan: 12,
  });

  // One line takes the Tab key; the arrows move from it, as in a tree.
  const [active, setActive] = useState(0);
  const at = Math.min(active, Math.max(0, lines.length - 1));
  const focusNext = useRef(false);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-line="${String(at)}"]`)
      ?.focus();
  });
  const go = (index: number) => {
    const next = Math.max(0, Math.min(lines.length - 1, index));
    focusNext.current = true;
    virtualizer.scrollToIndex(next);
    setActive(next);
  };

  function onKeyDown(event: KeyboardEvent, index: number) {
    const line = lines[index];
    if (!line || event.target !== event.currentTarget) return;
    switch (event.key) {
      case "ArrowDown":
        go(index + 1);
        break;
      case "ArrowUp":
        go(index - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(lines.length - 1);
        break;
      case "ArrowRight":
        // Unfolds; on a row already unfolded, goes to its first row.
        if (line.children === 0) return;
        if (line.folded) toggle(line.row.id);
        else go(index + 1);
        break;
      case "ArrowLeft": {
        // Folds; on a row with nothing to fold, goes to the row above it.
        if (line.children > 0 && !line.folded) {
          toggle(line.row.id);
          break;
        }
        let above = index - 1;
        while (above >= 0 && (lines[above]?.level ?? 0) >= line.level) {
          above -= 1;
        }
        if (above < 0) return;
        go(above);
        break;
      }
      case "Enter":
      case " ":
        table.openRecord(line.row.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-1.5">
        {parents.length > 0 ? (
          <ColumnPicker
            label={t`Rows under`}
            value={parent}
            columns={parents}
            onChange={(value) => props.onPatch({ parentColumn: value })}
          />
        ) : null}
        <ColumnPicker
          label={t`Row title`}
          value={titleName}
          columns={titleChoices}
          allowNone
          noneLabel={t`Primary field`}
          onChange={(value) => props.onPatch({ titleColumn: value })}
        />
        <CardFieldsPicker
          columns={props.columns}
          exclude={exclude}
          value={cardFields}
          onChange={(next) => props.onPatch({ cardFields: next })}
        />
        <span className="text-xs text-muted-foreground">
          {parents.length === 0
            ? t`To nest rows under one another, add a link to a row of this table.`
            : props.total > LIST_CEILING
              ? t`The first ${{ shown: formatNumber(LIST_CEILING, locale) }} of ${{ total: formatNumber(props.total, locale) }} rows`
              : plural(props.total, { one: `# row`, other: `# rows` })}
        </span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          role="tree"
          aria-label={t`Rows`}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtual) => {
            const line = lines[virtual.index];
            const tint = line ? props.tintOf?.(line.row) : undefined;
            return (
              <div
                key={line ? line.row.id : virtual.index}
                // Where the row sits: the tree holds its rows through it.
                role="none"
                data-index={virtual.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full border-b border-border"
                style={{ transform: `translateY(${String(virtual.start)}px)` }}
              >
                {line ? (
                  <div
                    role="treeitem"
                    aria-level={line.level}
                    aria-expanded={line.children > 0 ? !line.folded : undefined}
                    aria-selected={false}
                    data-line={virtual.index}
                    tabIndex={virtual.index === at ? 0 : -1}
                    className={cn(
                      "flex cursor-pointer items-start gap-1 py-2 pr-4 hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      tint && "border-l-2",
                    )}
                    style={{
                      paddingLeft: 12 + (line.level - 1) * INDENT,
                      ...(tint ? { borderLeftColor: tint } : {}),
                    }}
                    onClick={() => {
                      setActive(virtual.index);
                      table.openRecord(line.row.id);
                    }}
                    onFocus={() => setActive(virtual.index)}
                    onKeyDown={(event) => onKeyDown(event, virtual.index)}
                  >
                    {/* The arrow is the pointer's way; the keyboard has
                        the arrow keys, and the row says whether it is
                        unfolded. */}
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground",
                        line.children > 0 && "hover:bg-muted",
                      )}
                      onClick={
                        line.children > 0
                          ? (event) => {
                              event.stopPropagation();
                              toggle(line.row.id);
                            }
                          : undefined
                      }
                    >
                      {line.children === 0 ? null : line.folded ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-sm font-medium">
                          {title(line.row)}
                        </span>
                        {line.folded ? (
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {plural(line.children, {
                              one: `# row under it`,
                              other: `# rows under it`,
                            })}
                          </span>
                        ) : null}
                      </span>
                      <LineFields row={line.row} columns={fields} />
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {/* After the tree, not in it: a tree holds its rows and nothing
            else. */}
        {props.canEdit ? (
          <button
            type="button"
            onClick={() =>
              void props.onCreate({}).then((id) => id && table.openRecord(id))
            }
            className="flex h-11 w-full items-center gap-2 border-b border-border px-4 text-sm text-muted-foreground hover:bg-muted"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t`Add a row`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A row's chosen fields, on one line under its title: a name, a value. */
function LineFields({
  row,
  columns,
}: {
  row: RowItem;
  columns: ReturnType<typeof cardColumns>;
}) {
  const table = useTable();
  const shown = drawnFields(row, columns);
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 text-xs">
      {shown.map(({ column, value, error }) => (
        <span key={column.name} className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">{column.label}</span>
          <span className="flex min-w-0">
            <CellValueView
              value={value}
              column={column}
              locale={table.locale}
              people={table.people}
              inColumn={false}
              unticked
              error={error}
            />
          </span>
        </span>
      ))}
    </span>
  );
}
