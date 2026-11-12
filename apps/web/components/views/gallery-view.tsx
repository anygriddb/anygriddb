import { Paperclip, Plus } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { attachmentList } from "../../lib/format";
import type { RowItem } from "../../lib/types";
import { cardsOf } from "./gallery-lines";
import { useTable } from "../table/table-context";
import { cn, Select } from "@anygriddb/ui";
import {
  CardFields,
  CardFieldsPicker,
  cardColumns,
  ColumnPicker,
  useRowTitle,
  type ViewProps,
} from "./view-common";
import { useLingui } from "@lingui/react/macro";

const CARD_MIN = 240;
const CARD_GAP = 16;
const ADD_CARD = "__add__";

export function GalleryView(props: ViewProps) {
  const { t } = useLingui();
  const table = useTable();
  const titleName =
    typeof props.config.titleColumn === "string"
      ? props.config.titleColumn
      : undefined;
  const title = useRowTitle(titleName);
  const attachments = props.allColumns.filter(
    (column) => column.fieldType === "attachment",
  );
  const cover =
    typeof props.config.coverColumn === "string"
      ? props.config.coverColumn
      : undefined;
  const exclude = cover ? [cover] : [];
  const fields = cardColumns(props.config, props.columns, exclude);
  const cardFields = Array.isArray(props.config.cardFields)
    ? (props.config.cardFields as string[])
    : undefined;
  const titleChoices = props.columns.filter(
    (column) => column.fieldType !== "attachment",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState(1);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth - 32;
      setLanes(
        Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN + CARD_GAP))),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Every row of the view has its place; the card that adds one comes last.
  const count = props.total + (props.canEdit ? 1 : 0);
  // Rows of cards, each measured once drawn: a card is as tall as its
  // fields make it, and the cards of a row share the tallest one's height,
  // as in a plain grid.
  // TanStack Virtual hands back a mutable instance, so the React Compiler
  // leaves this component as written; its manual memoization stays.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: Math.ceil(count / lanes),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (cover ? 280 : 140),
    overscan: 4,
    gap: CARD_GAP,
  });
  const lines = virtualizer.getVirtualItems();
  // The rows of the cards drawn are read as they come into view.
  const firstCard = (lines[0]?.index ?? 0) * lanes;
  const lastCard = ((lines.at(-1)?.index ?? 0) + 1) * lanes - 1;
  const { ensure } = props;
  useEffect(() => {
    ensure(firstCard, lastCard);
  }, [ensure, firstCard, lastCard]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-1.5">
        <ColumnPicker
          label={t`Title`}
          value={titleName}
          columns={titleChoices}
          allowNone
          onChange={(value) => props.onPatch({ titleColumn: value })}
        />
        <ColumnPicker
          label={t`Cover`}
          value={cover}
          columns={attachments}
          allowNone
          onChange={(value) => props.onPatch({ coverColumn: value })}
        />
        {cover ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t`Fit`}
            <Select
              className="h-7 w-28 text-xs"
              value={props.config.coverFit === "contain" ? "contain" : "cover"}
              onChange={(event) =>
                props.onPatch({
                  coverFit:
                    event.target.value === "contain" ? "contain" : "cover",
                })
              }
            >
              <option value="cover">{t`Cover`}</option>
              <option value="contain">{t`Contain`}</option>
            </Select>
          </label>
        ) : null}
        <CardFieldsPicker
          columns={props.columns}
          exclude={exclude}
          value={cardFields}
          onChange={(next) => props.onPatch({ cardFields: next })}
        />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {lines.map((virtual) => (
            <div
              key={virtual.key}
              data-index={virtual.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 grid w-full gap-4"
              style={{
                transform: `translateY(${String(virtual.start)}px)`,
                gridTemplateColumns: `repeat(${String(lanes)}, minmax(0, 1fr))`,
              }}
            >
              {cardsOf(virtual.index, lanes, count).map((index) => {
                const item =
                  index === props.total ? ADD_CARD : props.rowAt(index);
                if (item === undefined) {
                  return (
                    <div
                      key={`waiting-${String(index)}`}
                      aria-hidden
                      className="flex min-h-32 flex-col gap-2 rounded-sm border border-border p-3"
                    >
                      <span className="h-3 w-2/3 animate-pulse rounded-sm bg-muted" />
                      <span className="h-2.5 w-1/2 animate-pulse rounded-sm bg-muted" />
                    </div>
                  );
                }
                if (item === ADD_CARD) {
                  return (
                    <button
                      key={ADD_CARD}
                      type="button"
                      onClick={() =>
                        void props
                          .onCreate({})
                          .then((id) => id && table.openRecord(id))
                      }
                      className="flex min-h-32 items-center justify-center gap-1 rounded-sm border border-dashed border-border text-sm text-muted-foreground hover:bg-muted"
                    >
                      <Plus className="h-4 w-4" aria-hidden />
                      {t`Add a card`}
                    </button>
                  );
                }
                const row = item;
                const files = attachmentList(
                  cover ? row[cover as keyof RowItem] : undefined,
                );
                const image = files.find((file) => file.thumb);
                const tint = props.tintOf?.(row);
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => table.openRecord(row.id)}
                    className={cn(
                      "flex flex-col overflow-hidden rounded-sm border border-border bg-card text-left hover:border-strong-border",
                      tint && `row-tint-${tint}`,
                    )}
                  >
                    {cover ? (
                      <div className="flex h-36 shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground">
                        {image ? (
                          <img
                            src={`/api/attachments/${image.key}/thumb`}
                            alt={image.filename}
                            loading="lazy"
                            className={
                              props.config.coverFit === "contain"
                                ? "h-full w-full object-contain"
                                : "h-full w-full object-cover"
                            }
                          />
                        ) : (
                          <>
                            <Paperclip className="h-5 w-5" aria-hidden />
                            {files.length > 0 ? (
                              <span className="ml-1 text-xs">
                                {files.length}
                              </span>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                    <div className="p-3">
                      <p className="truncate font-medium">{title(row)}</p>
                      <CardFields row={row} columns={fields} />
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
