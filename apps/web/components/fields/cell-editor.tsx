import {
  cellText,
  coerceCellValue,
  readCellValue,
  MAX_CELL_FILES,
  parseColor,
} from "@anygriddb/core";
import {
  Avatar,
  Button,
  Checkbox,
  cn,
  DatePicker,
  type DateValue,
  ListPicker,
  OptionBadge,
  type PickerOption,
  Spinner,
  Tooltip,
} from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Plus, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  dateFieldLocale,
  dateFormatOf,
  editZone,
  fromDateValue,
  sameDate,
  startingPoint,
  toDateValue,
} from "../../lib/dates";
import { readingIn, useRefusedText } from "../../lib/cell-reading";
import { attachmentList, isLinkArray } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useFormatBytes } from "../../lib/format-bytes";
import {
  FileRefused,
  filesThatFit,
  sendFile,
  tableFileUrl,
} from "../../lib/send-file";
import { readTypedDate, shownDate } from "../../lib/typed-date";
import { trpc, useTRPC } from "../../lib/trpc";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { useTable, type CellValue } from "../table/table-context";
import { optionsOf } from "./cell-value";
import {
  multiSelectAppearance,
  ratingVisual,
  singleSelectAppearance,
} from "./field-appearance";
import { RatingControl } from "./rating-control";
import { editableText, editingOf, type Typing } from "./field-editing";
import { AttachmentPreview } from "./attachment-preview";
import { linkedRowDraft } from "./link-actions";
import { panelPlacement, visibleBox, type Placement } from "./panel-placement";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { LIST_PANEL_ATTRIBUTE } from "../../lib/keyboard-undo";

type Move = "down" | "right" | "left";

type EditorProps = {
  column: CatalogColumn;
  row: RowItem;
  /** Text typed to start editing; replaces the current value. */
  initialText?: string;
  /** Told how to read what the editor holds, should its row go away. */
  onDraft?: (read: () => string) => void;
  onDone: (move?: Move) => void;
};

/**
 * What the cell held when its editor opened: what the person saw, and what
 * their change is compared with, whatever the page read since (ADR 0103).
 */
function useSeenAtOpen(
  row: RowItem,
  column: CatalogColumn,
): Record<string, CellValue> {
  const [seen] = useState(() => ({
    [column.name]: (row[column.name as keyof RowItem] ?? null) as CellValue,
  }));
  return seen;
}

function toCellColumn(column: CatalogColumn) {
  return {
    fieldType: column.fieldType,
    config: column.config,
    ...(column.instantDigits ? { instantDigits: column.instantDigits } : {}),
  };
}

/**
 * The keys that end an edit, read before the field sees them: Escape
 * leaves the value as it was, Enter keeps it and goes down, Tab keeps it
 * and goes sideways.
 */
function endingKey(
  event: KeyboardEvent,
  end: (move: Move | undefined, keep: boolean) => void,
): void {
  const move: Move | undefined =
    event.key === "Enter"
      ? "down"
      : event.key === "Tab"
        ? event.shiftKey
          ? "left"
          : "right"
        : undefined;
  if (event.key !== "Escape" && move === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  end(move, event.key !== "Escape");
}

const INLINE_EDITOR_CLASS =
  "absolute inset-0 z-20 w-full min-w-full rounded-none border-2 border-primary bg-card px-2 text-sm text-foreground shadow-lg outline-none";

function InlineEditor({
  column,
  row,
  typing,
  initialText,
  onDraft,
  onDone,
}: EditorProps & { typing: Typing }) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const refusedText = useRefusedText();
  const { updateCells } = useTable();
  const seen = useSeenAtOpen(row, column);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const current = row[column.name as keyof RowItem];
  const [text, setText] = useState(
    initialText ?? editableText(current, column.fieldType, locale),
  );
  const committed = useRef(false);
  const multiline = typing.lines === "many";
  const invalid =
    text.trim() !== "" &&
    coerceCellValue(toCellColumn(column), text, readingIn(locale)) ===
      undefined;
  useEffect(() => {
    const element = ref.current;
    if (element) onDraft?.(() => element.value);
  }, [onDraft]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    if (initialText === undefined && "select" in element) {
      element.select();
    } else if (
      initialText !== undefined &&
      element instanceof HTMLTextAreaElement
    ) {
      // Typing opened the editor with its first key: the next ones go
      // after it. A text area puts the caret first otherwise.
      const end = element.value.length;
      element.setSelectionRange(end, end);
    }
  }, [initialText]);

  async function commit(move?: Move) {
    if (committed.current) return;
    committed.current = true;
    const original = editableText(current, column.fieldType, locale);
    if (text === original) {
      onDone(move);
      return;
    }
    const reading = readCellValue(
      toCellColumn(column),
      text,
      readingIn(locale),
    );
    if ("refused" in reading) {
      toast.error(refusedText(column.label, reading.refused));
      committed.current = false;
      return;
    }
    onDone(move);
    await updateCells([
      { rowId: row.id, values: { [column.name]: reading.value }, seen },
    ]);
  }

  function onKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    // A long text and a document take Enter as a new line; Ctrl+Enter
    // ends them.
    if (
      event.key === "Enter" &&
      multiline &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      return;
    }
    endingKey(event, (move, keep) => {
      if (keep) {
        void commit(move);
        return;
      }
      committed.current = true;
      onDone();
    });
  }

  const shared = {
    value: text,
    "aria-label": column.label,
    "aria-invalid": invalid || undefined,
    onChange: (event: { target: { value: string } }) =>
      setText(event.target.value),
    onKeyDown,
    onBlur: () => void commit(),
    // A click in the field moves the caret, not the grid's selection.
    onPointerDown: (event: { stopPropagation: () => void }) =>
      event.stopPropagation(),
  };
  if (multiline) {
    return (
      <textarea
        ref={ref}
        {...shared}
        className={cn(
          INLINE_EDITOR_CLASS,
          "bottom-auto h-40 py-1.5",
          typing.code && "font-mono text-xs",
        )}
        spellCheck={typing.code ? false : undefined}
      />
    );
  }
  if (typing.swatch) {
    // A colour is typed, or picked: the picker writes what is typed, and
    // going from one to the other does not end the edit.
    return (
      <>
        <input
          ref={ref}
          {...shared}
          onBlur={(event) => {
            if (event.relatedTarget !== pickerRef.current) void commit();
          }}
          className={cn(
            INLINE_EDITOR_CLASS,
            "pr-10 font-mono",
            invalid && "border-danger",
          )}
          type="text"
          placeholder="#1f3fae"
        />
        <input
          ref={pickerRef}
          type="color"
          aria-label={t`Pick a colour`}
          className="absolute top-1/2 right-1.5 z-30 h-5 w-7 -translate-y-1/2 cursor-pointer rounded-sm border border-border bg-card p-0"
          value={parseColor(text) ?? "#000000"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (event.relatedTarget !== ref.current) void commit();
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      </>
    );
  }
  return (
    <input
      ref={ref}
      {...shared}
      className={cn(INLINE_EDITOR_CLASS, invalid && "border-danger")}
      type={typing.input}
      inputMode={typing.digits ? "decimal" : undefined}
    />
  );
}

/**
 * A date, or a date and time, in segments that follow the field's format
 * and time zone, with a calendar. A key that opened the editor goes into
 * its first segment.
 */
function DateEditor({
  column,
  row,
  withTime,
  initialText,
  onDraft,
  onDone,
}: EditorProps & { withTime: boolean }) {
  const { t } = useLingui();
  const { updateCells, locale } = useTable();
  const seen = useSeenAtOpen(row, column);
  const format = dateFormatOf(column);
  const zone = editZone(format);
  const current = row[column.name as keyof RowItem];
  const [draft, setDraft] = useState<DateValue | null>(() =>
    initialText === undefined ? toDateValue(current, withTime, zone) : null,
  );
  const latest = useRef(draft);
  const [isOpen, setIsOpen] = useState(false);
  const open = useRef(false);
  const picked = useRef(false);
  const committed = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  // A field wider than its cell grows to the right; at the grid's right
  // edge, it moves left over the cells before it instead of being cut.
  useLayoutEffect(() => {
    const element = box.current;
    const frame = element?.closest('[role="grid"]');
    if (!element || !frame) return;
    const over =
      element.getBoundingClientRect().right -
      frame.getBoundingClientRect().right;
    if (over > 0) element.style.left = `${-Math.ceil(over)}px`;
  }, []);

  useEffect(() => {
    const element = box.current;
    if (element) onDraft?.(() => shownDate(element));
  }, [onDraft]);

  useEffect(() => {
    if (!initialText) return;
    const segment = box.current?.querySelector<HTMLElement>(
      '[role="spinbutton"]',
    );
    if (!segment) return;
    segment.focus();
    segment.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: initialText,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, [initialText]);

  /**
   * Ends the edit with what the segments say, read before the field moves
   * a date that does not exist to one that does. A day picked in the
   * calendar is the field's value: its segments are not drawn yet.
   * Says whether the edit ended.
   */
  function commit(move?: Move, picking = false): boolean {
    if (committed.current) return true;
    const typed =
      picking || !box.current
        ? null
        : readTypedDate(box.current, {
            withTime,
            zone,
            held: latest.current,
          });
    if (typed?.state === "partial") {
      toast.error(t`Invalid value for ${{ field: column.label }}`);
      return false;
    }
    if (typed?.state === "impossible") {
      toast.error(
        t`${{ field: column.label }}: “${{ date: typed.text }}” does not exist. Nothing was saved.`,
      );
      return false;
    }
    committed.current = true;
    // A letter that opened the editor wrote nothing: the date stays.
    if (
      typed?.state === "empty" &&
      initialText !== undefined &&
      !/^\d$/.test(initialText)
    ) {
      onDone(move);
      return true;
    }
    const next = fromDateValue(
      typed?.state === "date"
        ? typed.value
        : typed?.state === "empty"
          ? null
          : latest.current,
      withTime,
    );
    onDone(move);
    if (!sameDate(current, next, withTime)) {
      void updateCells([
        { rowId: row.id, values: { [column.name]: next }, seen },
      ]);
    }
    return true;
  }

  return (
    <div
      ref={box}
      className="absolute top-0 left-0 z-20 h-full min-w-full"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        // The calendar takes its own keys while it is open.
        if (open.current) return;
        endingKey(event, (move, keep) => {
          if (keep) {
            commit(move);
            return;
          }
          committed.current = true;
          onDone();
        });
      }}
      onBlurCapture={(event) => {
        // Focus leaving the calendar (it closes, or a day was picked) is
        // not the editor's end: only focus leaving the field itself is.
        if (open.current || !box.current?.contains(event.target)) return;
        const next = event.relatedTarget;
        if (next instanceof Node && box.current.contains(next)) return;
        // Refused: the field must not go on to correct what was typed.
        if (!commit()) event.stopPropagation();
      }}
    >
      <DatePicker
        variant="cell"
        aria-label={column.label}
        value={draft}
        onChange={(value) => {
          latest.current = value;
          setDraft(value);
          if (open.current) picked.current = true;
        }}
        granularity={withTime ? "minute" : "day"}
        hourCycle={
          format.hour12 === undefined ? undefined : format.hour12 ? 12 : 24
        }
        hideTimeZone={!format.timeZone}
        placeholderValue={withTime ? startingPoint(zone) : undefined}
        locale={dateFieldLocale(locale, format.format)}
        isOpen={isOpen}
        onOpenChange={(value) => {
          open.current = value;
          setIsOpen(value);
          // A day picked in the calendar is the answer.
          if (!value && picked.current) {
            picked.current = false;
            commit(undefined, true);
          }
        }}
        autoFocus
      />
    </div>
  );
}

/** A rating: clickable glyphs (icon/colour from the field), arrows, digits. */
function RatingEditor({ column, row, initialText, onDone }: EditorProps) {
  const { updateCells } = useTable();
  const seen = useSeenAtOpen(row, column);
  const { max } = ratingVisual(column);
  const current = row[column.name as keyof RowItem];
  const stored = typeof current === "number" ? current : null;
  const [value, setValue] = useState<number | null>(() => {
    if (initialText === undefined) return stored;
    return /^\d$/.test(initialText) ? Math.min(max, Number(initialText)) : null;
  });
  const committed = useRef(false);

  async function commit(next: number | null, move?: Move) {
    if (committed.current) return;
    committed.current = true;
    onDone(move);
    if (next === stored) return;
    await updateCells([
      { rowId: row.id, values: { [column.name]: next }, seen },
    ]);
  }

  return (
    <div
      className={cn(INLINE_EDITOR_CLASS, "flex items-center px-1.5")}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        void commit(value);
      }}
    >
      <RatingControl
        column={column}
        value={value}
        interactive
        autoFocus
        onChange={setValue}
        onCommit={(next) => void commit(next, "down")}
        onCancel={() => {
          if (committed.current) return;
          committed.current = true;
          onDone();
        }}
      />
    </div>
  );
}

/**
 * A panel under the cell, turned toward the inside of the grid near its
 * right or bottom edge. Escape closes it; with `tabCloses`, so does Tab,
 * moving to the next cell, since the panel's list takes the arrows.
 */
function ListPanel({
  children,
  onClose,
  footer,
  paused = false,
  tabCloses = false,
}: {
  children: ReactNode;
  onClose: (move?: Move) => void;
  footer?: ReactNode;
  /** While a dialog opened from the panel is up, clicks there keep it. */
  paused?: boolean;
  tabCloses?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>({
    x: "start",
    y: "below",
  });
  useLayoutEffect(() => {
    const panel = ref.current;
    const cell = panel?.parentElement;
    if (!panel || !cell) return;
    // Measured at its tallest: a list that fills in later stays on screen.
    const style = getComputedStyle(panel);
    setPlacement(
      panelPlacement(
        cell.getBoundingClientRect(),
        {
          width: panel.offsetWidth,
          height: Number.parseFloat(style.maxHeight) || panel.offsetHeight,
        },
        visibleBox(panel),
      ),
    );
  }, []);
  useEffect(() => {
    if (paused) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [onClose, paused]);
  return (
    <div // NOSONAR: a popup around its list; the list and its search take the keys
      ref={ref}
      {...{ [LIST_PANEL_ATTRIBUTE]: "" }}
      className={cn(
        "absolute z-50 flex max-h-80 w-72 flex-col rounded-sm border border-border bg-card shadow-xl",
        placement.x === "end" ? "right-0" : "left-0",
        placement.y === "above" ? "bottom-0" : "top-0",
      )}
      // Clicks in the panel stay in it: the grid keeps its editor open.
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Tab" && tabCloses) {
          event.preventDefault();
          event.stopPropagation();
          onClose(event.shiftKey ? "left" : "right");
        }
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
      {footer ? (
        <div className="border-t border-border p-2">{footer}</div>
      ) : null}
    </div>
  );
}

function SelectEditor({
  column,
  row,
  multiple,
  onDone,
}: EditorProps & { multiple: boolean }) {
  const { t } = useLingui();
  const { updateCells } = useTable();
  const [query, setQuery] = useState("");
  const current = row[column.name as keyof RowItem];
  const pickedOf = (value: typeof current) =>
    Array.isArray(value) ? value.map(String) : value ? [cellText(value)] : [];
  const [picked, setPicked] = useState<string[]>(pickedOf(current));
  // An undo, or another person, changes the cell under the open panel. The
  // same choices read again are not a change: they leave the picks alone.
  const held = JSON.stringify(pickedOf(current));
  const [shown, setShown] = useState(held);
  if (shown !== held) {
    setShown(held);
    setPicked(pickedOf(current));
  }
  const selectAppearance = multiple
    ? multiSelectAppearance(column)
    : singleSelectAppearance(column);
  const options: PickerOption[] = optionsOf(column).map((option) => ({
    id: option.name,
    textValue: option.name,
    children: <OptionBadge color={option.color}>{option.name}</OptionBadge>,
  }));
  async function toggle(name: string) {
    if (multiple) {
      const next = picked.includes(name)
        ? picked.filter((item) => item !== name)
        : [...picked, name];
      setPicked(next);
      await updateCells([{ rowId: row.id, values: { [column.name]: next } }]);
      return;
    }
    onDone("down");
    await updateCells([
      {
        rowId: row.id,
        values: { [column.name]: picked[0] === name ? null : name },
      },
    ]);
  }
  if (!multiple && selectAppearance === "radio") {
    return (
      <ListPanel onClose={onDone} tabCloses>
        <div
          role="radiogroup"
          aria-label={column.label}
          className="flex max-h-72 flex-col gap-1 overflow-auto p-2"
        >
          {optionsOf(column).map((option) => {
            const checked = picked[0] === option.name;
            return (
              <label
                key={option.name}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-sm hover:bg-muted"
              >
                <input
                  type="radio"
                  name={`select-${column.name}`}
                  checked={checked}
                  className="accent-primary"
                  onChange={() => void toggle(option.name)}
                />
                <OptionBadge color={option.color}>{option.name}</OptionBadge>
              </label>
            );
          })}
        </div>
      </ListPanel>
    );
  }
  if (multiple && selectAppearance === "checklist") {
    return (
      <ListPanel onClose={onDone} tabCloses>
        <div
          role="group"
          aria-label={column.label}
          className="flex max-h-72 flex-col gap-1 overflow-auto p-2"
        >
          {optionsOf(column).map((option) => {
            const checked = picked.includes(option.name);
            return (
              <label
                key={option.name}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-sm hover:bg-muted"
              >
                <Checkbox
                  checked={checked}
                  onChange={() => void toggle(option.name)}
                />
                <OptionBadge color={option.color}>{option.name}</OptionBadge>
              </label>
            );
          })}
        </div>
      </ListPanel>
    );
  }
  return (
    <ListPanel onClose={onDone} tabCloses>
      <ListPicker
        label={t`Search an option`}
        listLabel={column.label}
        inputValue={query}
        onInputChange={setQuery}
        filter
        options={options}
        selectionMode={multiple ? "multiple" : "single"}
        selected={picked}
        onToggle={(name) => void toggle(name)}
        empty={t`No options`}
      />
    </ListPanel>
  );
}

function UserEditor({ column, row, onDone }: EditorProps) {
  const { t } = useLingui();
  const { updateCells, people } = useTable();
  const [query, setQuery] = useState("");
  const multiple = (column.config as { multiple?: boolean }).multiple === true;
  const current = row[column.name as keyof RowItem];
  const [picked, setPicked] = useState<string[]>(
    Array.isArray(current) ? current.map(String) : [],
  );
  // An undo, or another person, changes the cell under the open panel.
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    setPicked(Array.isArray(current) ? current.map(String) : []);
  }
  const options: PickerOption[] = [...people.values()].map((person) => ({
    id: person.id,
    textValue: person.displayName,
    children: (
      <>
        <Avatar name={person.displayName} />
        <span className="truncate">{person.displayName}</span>
      </>
    ),
  }));
  async function toggle(id: string) {
    const next = picked.includes(id)
      ? picked.filter((item) => item !== id)
      : multiple
        ? [...picked, id]
        : [id];
    setPicked(next);
    if (!multiple) onDone("down");
    await updateCells([{ rowId: row.id, values: { [column.name]: next } }]);
  }
  return (
    <ListPanel onClose={onDone} tabCloses>
      <ListPicker
        label={t`Search a person`}
        listLabel={column.label}
        inputValue={query}
        onInputChange={setQuery}
        filter
        options={options}
        selectionMode={multiple ? "multiple" : "single"}
        selected={picked}
        onToggle={(id) => void toggle(id)}
        empty={t`No one found`}
      />
    </ListPanel>
  );
}

/** The option that creates a row from what was typed. */
const CREATE = "\u0000create";

function LinkEditor({ column, row, onDone }: EditorProps) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const { setLinks, table, tables } = useTable();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const current = row[column.name as keyof RowItem];
  const [picked, setPicked] = useState<Array<{ id: string; label: string }>>(
    isLinkArray(current) ? current : [],
  );
  // An undo, or another person, changes the cell under the open panel.
  const [shown, setShown] = useState(current);
  if (shown !== current) {
    setShown(current);
    setPicked(isLinkArray(current) ? current : []);
  }
  const single =
    column.fieldType === "relation_one_to_many" &&
    column.relation?.direction !== "inverse";
  const candidates = useQuery(
    api.rows.linkCandidates.queryOptions({
      tableId: table.id,
      column: column.name,
      search: debounced || undefined,
      limit: 30,
    }),
  );
  async function toggle(item: { id: string; label: string }) {
    const has = picked.some((link) => link.id === item.id);
    const next = has
      ? picked.filter((link) => link.id !== item.id)
      : single
        ? [item]
        : [...picked, item];
    setPicked(next);
    if (single) onDone("down");
    await setLinks(
      row.id,
      column.name,
      next.map((link) => link.id),
    );
  }
  // What was typed and matched no row becomes a row of the other table.
  const draft = linkedRowDraft(column, tables, query, readingIn(locale));
  const typed = query.trim().toLowerCase();
  const found = candidates.data?.rows ?? [];
  const typedExists = found.some(
    (item) => item.label.trim().toLowerCase() === typed,
  );
  async function createLinked() {
    if (!draft || creating) return;
    setCreating(true);
    try {
      const { id } = await trpc.rows.insert.mutate(draft);
      setQuery("");
      await queryClient.invalidateQueries({
        queryKey: api.rows.linkCandidates.pathKey(),
      });
      await toggle({ id, label: query.trim() });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setCreating(false);
    }
  }
  // Linked rows first, those that match what is typed, then the others.
  const linked = picked.filter(
    (link) => typed === "" || link.label.toLowerCase().includes(typed),
  );
  const others = found.filter(
    (item) => !picked.some((link) => link.id === item.id),
  );
  const labels = new Map(
    [...picked, ...found].map((item) => [item.id, item.label]),
  );
  const options: PickerOption[] = [...linked, ...others].map((item) => ({
    id: item.id,
    textValue: item.label || "—",
    children: <span className="truncate">{item.label || "—"}</span>,
  }));
  if (draft && !typedExists) {
    options.push({
      id: CREATE,
      textValue: t`Create “${{ text: query.trim() }}”`,
      children: (
        <>
          {creating ? <Spinner /> : <Plus className="h-4 w-4" aria-hidden />}
          <span className="truncate">
            {t`Create “${{ text: query.trim() }}”`}
          </span>
        </>
      ),
    });
  }
  return (
    <ListPanel onClose={onDone} tabCloses>
      <ListPicker
        label={t`Search a linked row`}
        listLabel={column.label}
        inputValue={query}
        onInputChange={setQuery}
        options={options}
        selectionMode={single ? "single" : "multiple"}
        selected={picked.map((link) => link.id)}
        onToggle={(id) => {
          if (id === CREATE) {
            void createLinked();
            return;
          }
          void toggle({ id, label: labels.get(id) ?? "" });
        }}
        empty={
          candidates.isLoading ? (
            <span className="flex justify-center">
              <Spinner />
            </span>
          ) : (
            t`No matching row`
          )
        }
      />
    </ListPanel>
  );
}
function AttachmentEditor({ column, row, onDone }: EditorProps) {
  const { t } = useLingui();
  const formatBytes = useFormatBytes();
  const errorText = useErrorText();
  const { updateCells, table } = useTable();
  const current = row[column.name as keyof RowItem];
  const files = useMemo(() => attachmentList(current), [current]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  async function upload(list: FileList) {
    // The room left is counted from the files held: not during a send.
    if (busy) {
      toast.warning(
        t`Too many files are being sent right now. Try again in a moment.`,
      );
      return;
    }
    const { fit, left } = filesThatFit([...list], files.length);
    if (left > 0) {
      toast.warning(
        plural(left, {
          one: `# file was not added: a cell holds ${MAX_CELL_FILES} at most`,
          other: `# files were not added: a cell holds ${MAX_CELL_FILES} at most`,
        }),
      );
    }
    if (fit.length === 0) return;
    setBusy(true);
    try {
      const added: string[] = [];
      for (const file of fit) {
        try {
          added.push((await sendFile(tableFileUrl(table.id), file)).key);
        } catch (cause) {
          if (!(cause instanceof FileRefused)) throw cause;
          toast.error(
            cause.reason === "full"
              ? errorText(cause)
              : cause.reason === "too_large"
                ? t`File too large`
                : cause.reason === "busy"
                  ? t`Too many files are being sent right now. Try again in a moment.`
                  : t`Upload refused`,
          );
        }
      }
      if (added.length > 0) {
        await updateCells([
          {
            rowId: row.id,
            values: {
              [column.name]: [...files.map((file) => file.key), ...added],
            },
          },
        ]);
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ListPanel
      onClose={() => onDone()}
      paused={preview !== null}
      footer={
        <>
          {preview !== null ? (
            <AttachmentPreview
              files={files}
              index={Math.min(preview, files.length - 1)}
              onIndex={setPreview}
              onClose={() => setPreview(null)}
            />
          ) : null}
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) void upload(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? <Spinner /> : <Plus className="h-4 w-4" aria-hidden />}
            {t`Add a file`}
          </Button>
        </>
      }
    >
      <ul
        className="overflow-y-auto p-2 text-sm"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files.length)
            void upload(event.dataTransfer.files);
        }}
      >
        {files.length === 0 ? (
          <li className="py-2 text-muted-foreground">{t`Drop files here`}</li>
        ) : null}
        {files.map((file, index) => (
          <li key={file.key} className="flex items-center gap-2 py-1">
            {file.thumb ? (
              <img
                src={`/api/attachments/${file.key}/thumb`}
                alt=""
                className="h-8 w-8 rounded object-cover"
              />
            ) : (
              <Paperclip className="h-4 w-4 opacity-60" aria-hidden />
            )}
            <Tooltip content={t`Preview: ${{ name: file.filename }}`}>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left hover:underline"
                onClick={() => setPreview(index)}
              >
                {file.filename}
              </button>
            </Tooltip>
            <span className="text-xs text-muted-foreground">
              {file.size > 0 ? formatBytes(file.size) : ""}
            </span>
            <button
              type="button"
              aria-label={t`Remove`}
              onClick={() =>
                void updateCells([
                  {
                    rowId: row.id,
                    values: {
                      [column.name]: files
                        .filter((item) => item.key !== file.key)
                        .map((item) => item.key),
                    },
                  },
                ])
              }
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </ListPanel>
  );
}

/**
 * The editor of a field, by how its type is edited (`editingOf`). A
 * checkbox is ticked where it is drawn; a button, a computed field and a
 * field kept by the system have none.
 */
export function CellEditor(props: EditorProps) {
  const editing = editingOf(props.column.fieldType);
  switch (editing.by) {
    case "typing":
      return <InlineEditor {...props} typing={editing} />;
    case "options":
      return <SelectEditor {...props} multiple={editing.multiple === true} />;
    case "people":
      return <UserEditor {...props} />;
    case "links":
      return <LinkEditor {...props} />;
    case "files":
      return <AttachmentEditor {...props} />;
    case "date":
      return <DateEditor {...props} withTime={editing.time === true} />;
    case "rating":
      return <RatingEditor {...props} />;
    case "checkbox":
    case "button":
    case "none":
      return null;
  }
}
