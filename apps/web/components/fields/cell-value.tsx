import { cellText, isEmail, isHttpUrl } from "@anygriddb/core";

import { Avatar, cn, OptionBadge } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Check, Paperclip } from "lucide-react";
import type { ReactNode } from "react";
import { attachmentList, cellDisplay, isLinkArray } from "../../lib/format";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import {
  booleanAppearance,
  multiSelectAppearance,
  singleSelectAppearance,
} from "./field-appearance";
import { RatingControl } from "./rating-control";

type Option = { name: string; color: string };

export function optionsOf(column: CatalogColumn): Option[] {
  const config = column.config as { options?: Option[] };
  return config.options ?? [];
}

export function highlight(text: string, search: string): ReactNode {
  if (!search || !text) return text;
  const index = text.toLowerCase().indexOf(search.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + search.length)}</mark>
      {text.slice(index + search.length)}
    </>
  );
}

/** Read-only rendering of a cell, shared by the grid, cards, and the record panel. */
export function CellValueView({
  value,
  column,
  locale,
  people,
  search = "",
  wrap = false,
  inColumn = true,
  error = null,
  onOpenLink,
  onOpenFile,
}: {
  value: unknown;
  column: CatalogColumn;
  locale: "fr" | "en";
  people: ReadonlyMap<string, Collaborator>;
  search?: string;
  wrap?: boolean;
  /**
   * In a column of values (a grid), numbers line up on the right; under a
   * label (a card), they start where the label does.
   */
  inColumn?: boolean;
  /** The error the value is (ERROR in a formula, ADR 0036), with its message. */
  error?: string | null;
  /** Opens a linked row: links become buttons when given. */
  onOpenLink?: (link: { id: string; label: string }) => void;
  /** Opens the preview of the file at `index`: files become buttons. */
  onOpenFile?: (index: number) => void;
}) {
  const { t } = useLingui();
  if (column.error) {
    return <span className="text-xs text-danger">#{column.error}</span>;
  }
  if (error !== null) {
    return (
      <span className="text-xs text-danger" title={t`Formula error`}>
        #{error || t`ERROR`}
      </span>
    );
  }
  if (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return null;
  }
  const type = column.fieldType;
  if (
    type === "boolean" ||
    (column.kind === "boolean" && typeof value === "boolean")
  ) {
    const appearance = booleanAppearance(column);
    if (appearance === "yes_no") {
      return (
        <span className="text-sm">
          {value === true ? t`Yes` : value === false ? t`No` : null}
        </span>
      );
    }
    if (appearance === "switch") {
      const on = value === true;
      return (
        <span
          role="img"
          aria-label={on ? t`checked` : t`unchecked`}
          className={cn(
            "inline-flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors",
            on ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "h-3 w-3 rounded-full bg-card shadow-sm transition-transform",
              on ? "translate-x-3" : "translate-x-0",
            )}
            aria-hidden
          />
        </span>
      );
    }
    return value === true ? (
      <span
        role="img"
        aria-label={t`checked`}
        className="inline-flex h-4 w-4 items-center justify-center rounded bg-primary text-primary-foreground"
      >
        <Check className="h-3 w-3" aria-hidden />
      </span>
    ) : null;
  }
  if (type === "single_select" || type === "multi_select") {
    const options = optionsOf(column);
    const names = Array.isArray(value)
      ? value.map(cellText)
      : [cellText(value)];
    const appearance =
      type === "single_select"
        ? singleSelectAppearance(column)
        : multiSelectAppearance(column);
    // radio / checklist only change the editor; read stays badge (or text).
    const plain = appearance === "text";
    return (
      <span
        className={cn("flex gap-1", wrap ? "flex-wrap" : "overflow-hidden")}
      >
        {names.map((name) =>
          plain ? (
            <span key={name} className="truncate text-sm">
              {name}
            </span>
          ) : (
            <OptionBadge
              key={name}
              color={options.find((option) => option.name === name)?.color}
            >
              {name}
            </OptionBadge>
          ),
        )}
      </span>
    );
  }
  if (type === "rating" && typeof value === "number") {
    return <RatingControl column={column} value={value} />;
  }
  if (type === "user" || type === "created_by" || type === "last_modified_by") {
    const ids = Array.isArray(value) ? value.map(cellText) : [cellText(value)];
    return (
      <span
        className={cn("flex gap-1.5", wrap ? "flex-wrap" : "overflow-hidden")}
      >
        {ids.map((id) => {
          const name = people.get(id)?.displayName ?? "?";
          return (
            <span
              key={id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pr-2 pl-0.5 text-xs"
            >
              <Avatar name={name} className="h-5 w-5" />
              <span className="truncate">{name}</span>
            </span>
          );
        })}
      </span>
    );
  }
  if (type === "attachment") {
    const files = attachmentList(value);
    return (
      <span
        className={cn("flex gap-1", wrap ? "flex-wrap" : "overflow-hidden")}
      >
        {files.map((file, index) => {
          const item = file.thumb ? (
            <img
              src={`/api/attachments/${file.key}/thumb`}
              alt={file.filename}
              title={file.filename}
              loading="lazy"
              className={cn(
                "rounded border border-border object-cover",
                wrap ? "h-16 w-16" : "h-6 w-6",
              )}
            />
          ) : (
            <span
              title={file.filename}
              className="inline-flex max-w-40 items-center gap-1 rounded border border-border bg-muted px-1.5 text-xs leading-5"
            >
              <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{file.filename}</span>
            </span>
          );
          return onOpenFile ? (
            <button
              key={file.key}
              type="button"
              className="rounded outline-none hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t`Preview: ${{ name: file.filename }}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenFile(index);
              }}
            >
              {item}
            </button>
          ) : (
            <span key={file.key}>{item}</span>
          );
        })}
      </span>
    );
  }
  if (isLinkArray(value)) {
    return (
      <span
        className={cn("flex gap-1", wrap ? "flex-wrap" : "overflow-hidden")}
      >
        {value.map((link) =>
          onOpenLink ? (
            <button
              key={link.id}
              type="button"
              className="max-w-full truncate rounded border border-border bg-muted px-1.5 text-xs leading-5 text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              title={t`Open linked row`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenLink(link);
              }}
            >
              {highlight(link.label || "—", search)}
            </button>
          ) : (
            <span
              key={link.id}
              className="max-w-full truncate rounded border border-border bg-muted px-1.5 text-xs leading-5"
            >
              {highlight(link.label || "—", search)}
            </span>
          ),
        )}
      </span>
    );
  }
  const text = cellDisplay(value, column, locale, people);
  if (type === "url" && typeof value === "string") {
    if (!isHttpUrl(value)) {
      return <span className="truncate">{highlight(text, search)}</span>;
    }
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="truncate text-primary underline"
        onClick={(event) => event.stopPropagation()}
      >
        {highlight(text, search)}
      </a>
    );
  }
  if (type === "email" && typeof value === "string") {
    if (!isEmail(value)) {
      return <span className="truncate">{highlight(text, search)}</span>;
    }
    return (
      <a
        href={`mailto:${value}`}
        className="truncate text-primary underline"
        onClick={(event) => event.stopPropagation()}
      >
        {highlight(text, search)}
      </a>
    );
  }
  const numeric = column.kind === "number" && !Array.isArray(value);
  return (
    <span
      className={cn(
        wrap ? "break-words whitespace-pre-wrap" : "truncate",
        numeric && "tabular-nums",
        numeric && inColumn && "ml-auto",
        // An id is read character by character, and copied whole.
        type === "row_id" && "font-mono text-xs",
      )}
    >
      {highlight(text, search)}
    </span>
  );
}
