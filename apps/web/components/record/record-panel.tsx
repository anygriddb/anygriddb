import { cellText, isBlankCell, rowError } from "@anygriddb/core";
import {
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  CopyPlus,
  Printer,
  CornerDownRight,
  Link as LinkIcon,
  History as HistoryIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { attachmentList, cellDisplay } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import {
  canComment,
  canWrite,
  type CatalogColumn,
  type RowItem,
} from "../../lib/types";
import { AttachmentPreview } from "../fields/attachment-preview";
import { CellEditor, opensPanel } from "../fields/cell-editor";
import { linkTarget } from "../fields/link-actions";
import { ButtonCell } from "../fields/button-cell";
import { CellValueView } from "../fields/cell-value";
import { FieldIcon } from "../fields/field-meta";
import { isEditableColumn, isEditableLink } from "../grid/grid-clipboard";
import { useTable } from "../table/table-context";
import { CommentBody, MentionTextarea } from "./mention-input";
import { printRecord } from "./print-record";
import { RowStatus, useSubmitRow } from "./row-status";
import { canSubmitRow } from "./row-status-model";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { raw } from "../../lib/known-text";

const SKIP = new Set([
  "id",
  "ag_status",
  "ag_seq",
  "ag_position",
  "ag_created_at",
  "ag_updated_at",
  "ag_created_by",
  "ag_updated_by",
]);

/** Fields whose value draws its own empty state: never "Empty". */
const DRAWS_ITS_EMPTY = new Set(["button", "boolean", "rating"]);

function FieldRow({
  column,
  row,
  editable,
  asTitle = false,
}: {
  column: CatalogColumn;
  row: RowItem;
  editable: boolean;
  /** The primary field, written large as the panel's title. */
  asTitle?: boolean;
}) {
  const { t } = useLingui();
  const table = useTable();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const value = row[column.name as keyof RowItem];
  const box = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  // An edit that ends with nothing focused hands focus back to its button,
  // so the keyboard goes on from the field it left.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) {
      const focused = document.activeElement;
      if (
        !focused ||
        focused === document.body ||
        box.current?.contains(focused)
      ) {
        editButton.current?.focus();
      }
    }
    wasEditing.current = editing;
  }, [editing]);
  // A linked row opens in its own table, where the reader can see it.
  const target = linkTarget(column, table.tables);
  const openLink = target
    ? (link: { id: string }) =>
        void navigate({
          to: "/b/$baseId/t/$tableId/{-$viewId}",
          params: { baseId: table.baseId, tableId: target.id },
          search: { row: link.id },
        })
    : undefined;
  const files = column.fieldType === "attachment" ? attachmentList(value) : [];
  const canEditField =
    editable && (isEditableColumn(column) || isEditableLink(column));
  const toggle = () =>
    void table.updateCells([
      { rowId: row.id, values: { [column.name]: !value } },
    ]);
  // An empty value says so, where a click fills it in. A checkbox and a
  // rating draw their own empty state.
  const blank =
    isBlankCell(value) &&
    !DRAWS_ITS_EMPTY.has(column.fieldType) &&
    rowError(row, column.name) === null;
  return (
    <div
      ref={box}
      className={cn(
        "group flex flex-col gap-1",
        asTitle ? "pt-4 pb-3" : "py-2.5",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium text-muted-foreground",
          asTitle && "sr-only",
        )}
      >
        <FieldIcon fieldType={column.fieldType} />
        <span className="break-words">{column.label}</span>
      </div>
      <div
        {...(asTitle ? { role: "heading", "aria-level": 2 } : {})}
        className={cn(
          "relative -mx-2 min-h-8 rounded-md border border-transparent px-2 py-1",
          asTitle
            ? "text-xl leading-tight font-semibold break-words"
            : "text-sm",
          canEditField && "cursor-text hover:border-border",
          editing && !opensPanel(column.fieldType) && "h-9",
          column.fieldType === "long_text" && editing && "h-40",
        )}
        onClick={() => {
          if (!canEditField || editing) return;
          if (column.fieldType === "boolean") {
            toggle();
            return;
          }
          setEditing(true);
        }}
      >
        {canEditField && !editing ? (
          column.fieldType === "boolean" ? (
            <button
              ref={editButton}
              type="button"
              role="checkbox"
              aria-checked={value === true}
              aria-label={column.label}
              className="absolute inset-0 z-[1] rounded-md outline-none focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(event) => {
                event.stopPropagation();
                toggle();
              }}
            />
          ) : (
            <Tooltip content={t`Edit ${{ field: column.label }}`} side="left">
              <button
                ref={editButton}
                type="button"
                aria-label={t`Edit ${{ field: column.label }}`}
                className="absolute top-1 right-1 z-[1] inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-muted focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing(true);
                }}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          )
        ) : null}
        {column.fieldType === "button" ? (
          <ButtonCell column={column} row={row} />
        ) : blank ? (
          <span className="text-muted-foreground">
            {asTitle ? t`Untitled` : t`No value`}
          </span>
        ) : (
          <CellValueView
            value={value}
            column={column}
            locale={table.locale}
            people={table.people}
            wrap
            error={rowError(row, column.name)}
            onOpenLink={openLink}
            onOpenFile={files.length > 0 ? setPreview : undefined}
          />
        )}
        {preview !== null ? (
          <AttachmentPreview
            files={files}
            index={Math.min(preview, files.length - 1)}
            onIndex={setPreview}
            onClose={() => setPreview(null)}
          />
        ) : null}
        {editing ? (
          <CellEditor
            column={column}
            row={row}
            onDone={() => setEditing(false)}
          />
        ) : null}
        {column.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {column.description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Comments({ rowId }: { rowId: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const table = useTable();
  const session = useSession();
  const comments = useQuery(
    api.rows.comments.queryOptions({ tableId: table.table.id, rowId }),
  );
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(
    null,
  );
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.rows.comments.queryKey({
          tableId: table.table.id,
          rowId,
        }),
      }),
      // The grid's comment badges.
      queryClient.invalidateQueries({
        queryKey: api.rows.commentCounts.pathKey(),
      }),
    ]);
  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  const list = comments.data?.comments ?? [];
  const roots = list.filter((comment) => !comment.parentId);
  const render = (comment: (typeof list)[number], reply: boolean) => (
    <li key={comment.id} className={cn("flex gap-2", reply && "ml-8")}>
      <Avatar name={comment.displayName} />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <span className="font-medium">{comment.displayName}</span>{" "}
          <span className="text-muted-foreground">
            {new Date(comment.createdAt).toLocaleString(
              table.locale === "fr" ? "fr-FR" : "en-GB",
            )}
            {comment.updatedAt ? ` · ${t`edited`}` : ""}
          </span>
        </p>
        {editing?.id === comment.id ? (
          <form
            className="mt-1 flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await trpc.rows.updateComment.mutate({
                  commentId: comment.id,
                  body: editing.body,
                });
                setEditing(null);
              });
            }}
          >
            <MentionTextarea
              className="min-h-14"
              people={table.people}
              value={editing.body}
              onValueChange={(body) => setEditing({ id: comment.id, body })}
            />
            <div className="flex gap-1">
              <Button size="xs" type="submit">
                {t`Save`}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setEditing(null)}
              >
                {t`Cancel`}
              </Button>
            </div>
          </form>
        ) : (
          <p
            className={cn(
              "text-sm break-words whitespace-pre-wrap",
              comment.deleted && "text-muted-foreground italic",
            )}
          >
            {comment.deleted ? (
              t`Comment deleted`
            ) : (
              <CommentBody body={comment.body} />
            )}
          </p>
        )}
        {!comment.deleted ? (
          <div className="flex gap-2 text-xs text-muted-foreground">
            {!reply && canComment(table.role) ? (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setReplyTo(comment.id)}
              >
                {t`Reply`}
              </button>
            ) : null}
            {comment.authorId === session.data?.id ? (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() =>
                  setEditing({ id: comment.id, body: comment.body })
                }
              >
                <Pencil className="inline h-3 w-3" aria-hidden /> {t`Edit`}
              </button>
            ) : null}
            {comment.authorId === session.data?.id || table.role === "owner" ? (
              <button
                type="button"
                className="hover:text-danger"
                onClick={() =>
                  void run(() =>
                    trpc.rows.deleteComment.mutate({ commentId: comment.id }),
                  )
                }
              >
                <Trash2 className="inline h-3 w-3" aria-hidden /> {t`Delete`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {roots.map((comment) => [
          render(comment, false),
          ...list
            .filter((reply) => reply.parentId === comment.id)
            .map((reply) => render(reply, true)),
        ])}
        {list.length === 0 ? (
          <li className="text-sm text-muted-foreground">{t`No comments`}</li>
        ) : null}
      </ul>
      {canComment(table.role) ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!body.trim()) return;
            void run(async () => {
              await trpc.rows.addComment.mutate({
                tableId: table.table.id,
                rowId,
                body,
                parentId: replyTo ?? undefined,
              });
              setBody("");
              setReplyTo(null);
            });
          }}
        >
          {replyTo ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <CornerDownRight className="h-3 w-3" aria-hidden />
              {t`Reply`}
              <button
                type="button"
                aria-label={t`Cancel`}
                onClick={() => setReplyTo(null)}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </p>
          ) : null}
          <MentionTextarea
            aria-label={t`Comment`}
            className="min-h-16"
            placeholder={t`Write a comment… (@ to mention)`}
            people={table.people}
            value={body}
            onValueChange={setBody}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            size="sm"
            type="submit"
            className="self-end"
            disabled={!body.trim()}
          >
            {t`Comment`}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

const ACTION_LABELS: Record<string, MessageDescriptor> = {
  insert: msg`created the row`,
  update: msg`edited`,
  delete: msg`deleted the row`,
  submit: msg`submitted`,
  lock: msg`locked`,
  unlock: msg`unlocked`,
  sign: msg`signed`,
  changed: msg`found a change made outside AnyGridDB`,
  restored: msg`found the locked values back`,
};

const MOVED = msg`moved the row`;

function History({ rowId }: { rowId: string }) {
  const { t } = useLingui();
  const api = useTRPC();
  const table = useTable();
  const { locale } = useLocale();
  const audit = useQuery(
    api.rows.audit.queryOptions({ tableId: table.table.id, recordId: rowId }),
  );
  const byName = new Map(
    table.table.columns.map((column) => [column.name, column]),
  );
  return (
    <ul className="flex flex-col gap-3">
      {(audit.data?.events ?? []).map((event, index) => {
        const before = (event.oldValue ?? {}) as Record<string, unknown>;
        const after = (event.newValue ?? {}) as Record<string, unknown>;
        const changed = [
          ...new Set([...Object.keys(before), ...Object.keys(after)]),
        ].filter(
          (key) =>
            !SKIP.has(key) &&
            !key.startsWith("ag_tmp_") &&
            JSON.stringify(before[key] ?? null) !==
              JSON.stringify(after[key] ?? null),
        );
        // Only its place changed: the row was moved, not edited.
        const moved =
          event.action === "update" &&
          changed.length === 0 &&
          JSON.stringify(before.ag_position ?? null) !==
            JSON.stringify(after.ag_position ?? null);
        return (
          <li key={index} className="flex gap-2 text-sm">
            <Avatar name={event.displayName ?? "AnyGridDB"} />
            <div className="min-w-0 flex-1">
              <p className="text-xs">
                <span className="font-medium">
                  {event.displayName ?? "AnyGridDB"}
                </span>{" "}
                {t(
                  moved
                    ? MOVED
                    : (ACTION_LABELS[event.action] ?? raw(event.action)),
                )}
                <span className="ml-1 text-muted-foreground">
                  {new Date(event.occurredAt).toLocaleString(
                    locale === "fr" ? "fr-FR" : "en-GB",
                  )}
                  {event.source &&
                  event.source !== "web" &&
                  event.source !== "check"
                    ? ` · ${event.source}`
                    : ""}
                </span>
              </p>
              {event.state === "pending" || event.state === "unverified" ? (
                <p className="text-xs text-muted-foreground">
                  {event.state === "pending"
                    ? t`Pending: the client's database has not confirmed this change yet.`
                    : t`Unverified: the row has changed since, in the client's database.`}
                </p>
              ) : null}
              {event.fingerprint ? (
                <p
                  className="font-mono text-[11px] text-muted-foreground"
                  title={event.fingerprint}
                >
                  {t`SHA-256 fingerprint: ${{ short: event.fingerprint.slice(0, 16) }}…`}
                </p>
              ) : null}
              {event.missing ? (
                <p className="text-xs text-danger">
                  {t`The row has disappeared from the client's database.`}
                </p>
              ) : null}
              {event.reason ? (
                <p className="text-xs text-muted-foreground">
                  {t`Reason: ${{ reason: event.reason }}`}
                </p>
              ) : null}
              {event.action === "update" || event.action === "changed" ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {changed.map((key) => {
                    const column = byName.get(key);
                    const show = (value: unknown) =>
                      column
                        ? cellDisplay(value, column, locale, table.people) ||
                          "∅"
                        : JSON.stringify(value ?? null);
                    return (
                      <li
                        key={key}
                        className="rounded bg-muted px-2 py-1 text-xs"
                      >
                        <span className="font-medium">
                          {column?.label ?? key}
                        </span>{" "}
                        :{" "}
                        <span className="text-danger line-through">
                          {show(before[key])}
                        </span>{" "}
                        →{" "}
                        <span className="text-primary">{show(after[key])}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function RecordPanel({
  row,
  columns,
  onClose,
  onPrevious,
  onNext,
  onDuplicate,
  onDelete,
}: {
  row: RowItem | undefined;
  columns: readonly CatalogColumn[];
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  /** Given when the reader may add rows to the table. */
  onDuplicate?: () => void;
  /** Given when the reader may delete rows from the table. */
  onDelete?: () => void;
}) {
  const { t } = useLingui();
  const table = useTable();
  const copy = useCopy();
  const submitRow = useSubmitRow();
  // While the print dialog is open, the record is rendered under <body>
  // for the print style to show alone.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done, { once: true });
    printRecord(window);
    return () => window.removeEventListener("afterprint", done);
  }, [printing]);
  const [tab, setTab] = useState<"comments" | "history">("comments");
  const [showHidden, setShowHidden] = useState(false);
  if (!row) return null;
  const primary = table.table.columns.find((column) => column.isPrimary);
  const title = primary
    ? cellDisplay(
        row[primary.name as keyof RowItem],
        primary,
        table.locale,
        table.people,
      )
    : "";
  const titleColumn = primary
    ? columns.find((column) => column.name === primary.name)
    : undefined;
  const visible = new Set(columns.map((column) => column.name));
  const hidden = table.table.columns.filter(
    (column) => !visible.has(column.name),
  );
  const external = table.table.external !== null;
  // A client's row is edited only where an administrator enabled it.
  const unlocked = row.ag_status !== "locked" && row.ag_status !== "signed";
  const editable =
    canWrite(table.role) &&
    (table.table.external?.writes.update ?? true) &&
    unlocked;
  // A client's inverse link writes the other table (ADR 0006): it takes
  // changes when that table does, whatever this one allows.
  const editableField = (column: CatalogColumn) =>
    editable ||
    (external && canWrite(table.role) && unlocked && isEditableLink(column));
  return (
    <aside
      className="flex w-[26rem] max-w-full shrink-0 flex-col border-l border-border bg-card"
      aria-label={t`Row details`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border pr-2 pl-4">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {row.ag_seq === null || row.ag_seq === undefined
            ? row.id
            : t`Row ${{ number: cellText(row.ag_seq) }}`}
        </p>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Previous row`}
          disabled={!onPrevious}
          onClick={onPrevious}
        >
          <ChevronUp className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Next row`}
          disabled={!onNext}
          onClick={onNext}
        >
          <ChevronDown className="h-4 w-4" aria-hidden />
        </Button>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Copy row link`}
          title={t`Copy row link`}
          onClick={() =>
            copy(
              `${window.location.origin}${window.location.pathname}?row=${encodeURIComponent(row.id)}`,
              t`Link copied`,
            )
          }
        >
          <LinkIcon className="h-4 w-4" aria-hidden />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t`More actions`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setPrinting(true)}>
              <Printer className="h-4 w-4" aria-hidden />
              {t`Print the row`}
            </DropdownMenuItem>
            {onDuplicate ? (
              <DropdownMenuItem onSelect={onDuplicate}>
                <CopyPlus className="h-4 w-4" aria-hidden />
                {t`Duplicate row`}
              </DropdownMenuItem>
            ) : null}
            {canSubmitRow(row, table.role) ? (
              <DropdownMenuItem onSelect={() => void submitRow(row.id)}>
                <Send className="h-4 w-4" aria-hidden />
                {t`Submit the row for review`}
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger onSelect={onDelete}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t`Delete row`}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Close`}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </header>
      <RowStatus row={row} />
      <div className="flex-1 overflow-y-auto px-4">
        {/* The primary field is the title, edited where it is read; a
            view that hides it still names the row. */}
        {titleColumn ? (
          <FieldRow
            column={titleColumn}
            row={row}
            editable={editableField(titleColumn)}
            asTitle
          />
        ) : (
          <h2 className="pt-4 pb-3 text-xl leading-tight font-semibold break-words">
            {title || t`Untitled`}
          </h2>
        )}
        <div className="divide-y divide-rule border-t border-rule">
          {columns
            .filter((column) => column !== titleColumn)
            .map((column) => (
              <FieldRow
                key={column.name}
                column={column}
                row={row}
                editable={editableField(column)}
              />
            ))}
        </div>
        {hidden.length > 0 ? (
          <div className="py-2">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowHidden(!showHidden)}
            >
              {showHidden
                ? t`Hide ${{ count: hidden.length }} hidden fields`
                : t`Show ${{ count: hidden.length }} hidden fields`}
            </button>
            {showHidden ? (
              <div className="divide-y divide-border">
                {hidden.map((column) => (
                  <FieldRow
                    key={column.name}
                    column={column}
                    row={row}
                    editable={editableField(column)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2 pb-6">
          <div className="mb-3 flex gap-4 border-b border-rule" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "comments"}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-0.5 py-2 text-sm",
                tab === "comments"
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab("comments")}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
              {t`Comments`}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "history"}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-0.5 py-2 text-sm",
                tab === "history"
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab("history")}
            >
              <HistoryIcon className="h-3.5 w-3.5" aria-hidden />
              {t`History`}
            </button>
          </div>
          {tab === "comments" ? (
            <Comments rowId={row.id} />
          ) : (
            <>
              {external ? (
                <p className="mb-3 text-xs text-muted-foreground">
                  {t`Only changes made in AnyGridDB show here: those of other applications stay in the client's database.`}
                </p>
              ) : null}
              <History rowId={row.id} />
            </>
          )}
        </div>
      </div>
      {printing
        ? createPortal(
            <div data-print-root className="bg-white p-6 text-black">
              <p className="text-xs">
                {table.table.name},{" "}
                {row.ag_seq === null || row.ag_seq === undefined
                  ? row.id
                  : t`Row ${{ number: cellText(row.ag_seq) }}`}
              </p>
              <h1 className="mb-4 text-xl font-semibold">
                {title || t`Untitled`}
              </h1>
              <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-2 text-sm">
                {columns
                  .filter((column) => column.fieldType !== "button")
                  .map((column) => (
                    <div key={column.name} className="contents">
                      <dt className="font-medium break-words">
                        {column.label}
                      </dt>
                      <dd className="break-words whitespace-pre-wrap">
                        {cellDisplay(
                          row[column.name as keyof RowItem],
                          column,
                          table.locale,
                          table.people,
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}
