import {
  CELL_TEXT_LIMITS,
  type DayOrder,
  WRITABLE_TYPES,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Select,
  Spinner,
  getLocalTimeZone,
} from "@anygriddb/ui";
import { FileUp } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import {
  useJobErrorText,
  jobPercent,
  useJobs,
  useTrackJob,
  type Job,
  type JobUpdate,
} from "../../lib/jobs";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import type { CatalogColumn } from "../../lib/types";
import { FIELD_LABELS } from "../fields/field-meta";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { useLocale } from "../../lib/i18n";
import { raw } from "../../lib/known-text";
import { pastedFile } from "./pasted-data";

type Preview = {
  importId: string;
  filename: string;
  format: string;
  headers: string[];
  sample: string[][];
  total: number;
  inferred: Array<{ fieldType: string }>;
  /** Cells whose number reads two ways until the file's mark is known. */
  ambiguousNumbers: number;
  /** Cells like `1.234`, refused if the file's mark is a comma. */
  ambiguousPoints: number;
  /** Cells whose date reads two ways until the file's order is known. */
  ambiguousDates: number;
  /** The longest cell of each column. */
  longest: number[];
  /** How its text was read, when it is a text file. */
  encoding: "utf-8" | "windows-1252";
  /** Cells of each column with the apostrophe an export puts before a formula. */
  guarded: number[];
  /** Formula cells with no stored value, which stay empty. */
  emptyFormulas: number;
};

type Started = RouterOutputs["rows"]["importCommit"];

type ImportReport = {
  inserted: number;
  updated: number;
  failed: number;
  errors: Array<{
    line: number;
    column: string;
    value: string;
    message: string;
    /** What a client's database refused, as an error code. */
    code?: string;
    detail?: string;
  }>;
  /** Lines a later one with the same key replaced. */
  replaced: number;
  replacedLines: Array<{ line: number; by: number; key: string }>;
  /** Formula cells with no stored value, left empty. */
  emptyFormulas: number;
};

/** The report an import job ends with; missing parts read as empty. */
function importReport(result: Record<string, unknown> | null): ImportReport {
  const number = (key: string) =>
    typeof result?.[key] === "number" ? result[key] : 0;
  const errors = Array.isArray(result?.errors)
    ? (result.errors as ImportReport["errors"])
    : [];
  const replacedLines = Array.isArray(result?.replacedLines)
    ? (result.replacedLines as ImportReport["replacedLines"])
    : [];
  return {
    inserted: number("inserted"),
    updated: number("updated"),
    failed: number("failed"),
    errors,
    replaced: number("replaced"),
    replacedLines,
    emptyFormulas: number("emptyFormulas"),
  };
}

/** What an import did, in one sentence. */
function importSentence({ inserted, updated, failed }: ImportReport): string {
  return plural(inserted, {
    one: `# row added, ${updated} updated, ${failed} rejected.`,
    other: `# rows added, ${updated} updated, ${failed} rejected.`,
  });
}

/** What an import left out without refusing it, when it did. */
function importNotes({ replaced, emptyFormulas }: ImportReport): string[] {
  return [
    replaced > 0
      ? plural(replaced, {
          one: "# line was replaced by a later line with the same key.",
          other: "# lines were replaced by a later line with the same key.",
        })
      : "",
    emptyFormulas > 0
      ? plural(emptyFormulas, {
          one: "# formula had no stored value: its cell stayed empty.",
          other: "# formulas had no stored value: their cells stayed empty.",
        })
      : "",
  ].filter(Boolean);
}

/** What a failed import had already written, when it had. */
function keptSentence(job: Job): string | undefined {
  const { inserted, updated } = importReport(job.result);
  const kept = inserted + updated;
  return kept > 0
    ? plural(kept, {
        one: "The # row already written is kept.",
        other: "The # rows already written are kept.",
      })
    : undefined;
}

type ImportTarget =
  | { kind: "new"; baseId: string }
  | {
      kind: "existing";
      tableId: string;
      columns: readonly CatalogColumn[];
      canManage: boolean;
      /** A client's table: its foreign keys import as the key they hold. */
      external?: boolean;
    };

/** "" ignores the source column, "new" creates a field, else a column name. */
type Choice = { target: string; label: string; fieldType: string };

const CREATE_TYPES = WRITABLE_TYPES.filter((type) => type !== "attachment");
const ACCEPT = ".csv,.tsv,.txt,.json,.xlsx";

function initialChoices(preview: Preview, target: ImportTarget): Choice[] {
  return preview.headers.map((header, index) => {
    const fieldType = preview.inferred[index]?.fieldType ?? "text";
    if (target.kind === "new") {
      return { target: "new", label: header, fieldType };
    }
    const folded = header.trim().toLowerCase();
    const match = target.columns.find(
      (column) =>
        column.label.toLowerCase() === folded ||
        column.name.toLowerCase() === folded,
    );
    return {
      target: match?.name ?? "",
      label: header,
      fieldType,
    };
  });
}

export function ImportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ImportTarget;
  /** Called once the import is queued: a new table already exists then. */
  onStarted?: (started: Started) => void;
  /** Called when the rows are in. */
  onDone?: () => void;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const jobError = useJobErrorText();
  const errorText = useErrorText();
  const { watch } = useJobs();
  const trackJob = useTrackJob();
  /** The job this open dialog still shows; cleared once it moves to a toast. */
  const shown = useRef<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [tableName, setTableName] = useState("");
  const [upsertSource, setUpsertSource] = useState("");
  const [addOptions, setAddOptions] = useState(true);
  const [stripTextGuard, setStripTextGuard] = useState(false);
  const [decimalMark, setDecimalMark] = useState<"" | "." | ",">("");
  const [dayOrder, setDayOrder] = useState<"" | DayOrder>("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ImportReport | null>(null);
  const [running, setRunning] = useState<{
    jobId: string;
    update: JobUpdate | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [dragging, setDragging] = useState(false);

  const { target } = props;
  const writable = useMemo(
    () =>
      target.kind === "existing"
        ? target.columns.filter(
            (column) =>
              (WRITABLE_TYPES as readonly string[]).includes(
                column.fieldType,
              ) ||
              (target.external === true &&
                column.fieldType === "relation_one_to_many" &&
                column.insertable),
          )
        : [],
    [target],
  );
  const usedTargets = choices.map((choice) => choice.target);
  const mapped = choices.flatMap((choice, source) =>
    choice.target ? [{ choice, source }] : [],
  );
  const fieldTypeOf = (choice: Choice) =>
    choice.target === "new"
      ? choice.fieldType
      : writable.find((column) => column.name === choice.target)?.fieldType;
  /** Cells going to a text field with an export's apostrophe in front. */
  const guardedInText = mapped.reduce((sum, { choice, source }) => {
    const fieldType = fieldTypeOf(choice);
    return fieldType === "text" || fieldType === "long_text"
      ? sum + (preview?.guarded[source] ?? 0)
      : sum;
  }, 0);
  /** Mapped columns holding a value longer than their field keeps. */
  const tooLong = mapped.filter(({ choice, source }) => {
    const fieldType = fieldTypeOf(choice);
    const limit =
      fieldType === "text" || fieldType === "long_text"
        ? CELL_TEXT_LIMITS[fieldType]
        : undefined;
    return limit !== undefined && (preview?.longest[source] ?? 0) > limit;
  }).length;
  // In French a point can group thousands: `1.234` alone is worth asking.
  const asksDecimal =
    preview !== null &&
    (preview.ambiguousNumbers > 0 ||
      (locale === "fr" && preview.ambiguousPoints > 0));
  const needsReason =
    target.kind === "existing" &&
    mapped.some(({ choice }) =>
      target.columns.some(
        (column) => column.name === choice.target && column.requireReason,
      ),
    );

  function reset() {
    shown.current = null;
    setPreview(null);
    setChoices([]);
    setResult(null);
    setRunning(null);
    setUpsertSource("");
    setDecimalMark("");
    setDayOrder("");
    setStripTextGuard(false);
    setReason("");
    setPasted("");
  }

  function close(open: boolean) {
    if (!open && running) {
      const report = (job: Job) => {
        const done = importReport(job.result);
        return {
          message: [importSentence(done), ...importNotes(done)].join(" "),
        };
      };
      void trackJob(running.jobId, {
        label: t`Importing…`,
        onDone: (job) => {
          props.onDone?.();
          return report(job);
        },
        onFailed: keptSentence,
      });
    }
    if (!open) reset();
    props.onOpenChange(open);
  }

  async function upload(file: File) {
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const query =
        target.kind === "new"
          ? `baseId=${encodeURIComponent(target.baseId)}`
          : `tableId=${encodeURIComponent(target.tableId)}`;
      const response = await fetch(`/api/import/preview?${query}`, {
        method: "POST",
        body,
      });
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(
          response.status === 413
            ? t`File too large (256 MB, 64 MB for Excel, 20 MB for JSON).`
            : errorText(json),
        );
        return;
      }
      const parsed = json as Preview;
      setPreview(parsed);
      // French puts the day first; English is written both ways.
      setDayOrder(locale === "fr" ? "day-first" : "");
      setChoices(initialChoices(parsed, target));
      setTableName(parsed.filename.replace(/\.[^.]+$/, "").slice(0, 100));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }

  function update(index: number, patch: Partial<Choice>) {
    setChoices((current) =>
      current.map((choice, at) =>
        at === index ? { ...choice, ...patch } : choice,
      ),
    );
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    try {
      const mapping = mapped.map(({ choice, source }) =>
        choice.target === "new"
          ? {
              source,
              create: {
                label:
                  choice.label.trim() || t`Field ${{ position: source + 1 }}`,
                fieldType: choice.fieldType as (typeof CREATE_TYPES)[number],
              },
            }
          : { source, column: choice.target },
      );
      const started = await trpc.rows.importCommit.mutate({
        importId: preview.importId,
        target:
          target.kind === "new"
            ? { kind: "new", baseId: target.baseId, name: tableName.trim() }
            : { kind: "existing", tableId: target.tableId },
        mapping,
        upsertSource: upsertSource === "" ? undefined : Number(upsertSource),
        addOptions,
        reason: reason.trim() || undefined,
        decimalMark: decimalMark === "" ? undefined : decimalMark,
        dayOrder: dayOrder === "" ? undefined : dayOrder,
        timeZone: getLocalTimeZone(),
        stripTextGuard: guardedInText > 0 && stripTextGuard,
      });
      props.onStarted?.(started);
      shown.current = started.jobId;
      setRunning({ jobId: started.jobId, update: null });
      setBusy(false);
      const job = await watch(started.jobId, (update) =>
        setRunning((current) =>
          current?.jobId === started.jobId ? { ...current, update } : current,
        ),
      );
      // Closed meanwhile: the toast that took over reports the end.
      if (shown.current !== started.jobId) return;
      setRunning(null);
      if (job.status === "done") {
        setResult(importReport(job.result));
        props.onDone?.();
      } else if (job.status === "cancelled") {
        toast.message(
          t`Import cancelled: ${plural(job.done, { one: "the # row already written is kept", other: "the # rows already written are kept" })}.`,
        );
        props.onDone?.();
        close(false);
      } else {
        const kept = keptSentence(job);
        toast.error(kept ? `${jobError(job)} ${kept}` : jobError(job));
        if (kept) props.onDone?.();
        setPreview(null);
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const title = target.kind === "new" ? t`Import a new table` : t`Import rows`;

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent title={title} wide>
        {running ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              {running.update && jobPercent(running.update) !== null
                ? t`Importing: ${{ done: running.update.done }} of ${{ total: running.update.total ?? 0 }} rows.`
                : running.update?.status === "running"
                  ? t`Preparing the import…`
                  : t`Import queued…`}
            </p>
            <div
              className="h-2 overflow-hidden rounded bg-muted"
              role="progressbar"
              aria-label={t`Import progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                running.update
                  ? (jobPercent(running.update) ?? undefined)
                  : undefined
              }
            >
              <div
                className="h-full bg-primary transition-[width]"
                style={{
                  width: `${running.update ? (jobPercent(running.update) ?? 5) : 5}%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t`You can close this window: the import goes on and stays in the jobs menu.`}
            </p>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  trpc.jobs.cancel
                    .mutate({ jobId: running.jobId })
                    .catch((cause: unknown) => toast.error(errorText(cause)));
                }}
              >
                {t`Cancel the import`}
              </Button>
              <Button onClick={() => close(false)}>
                {t`Continue in the background`}
              </Button>
            </DialogFooter>
          </div>
        ) : result ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>{importSentence(result)}</p>
            {importNotes(result).map((note) => (
              <p key={note} role="status" className="text-xs text-warning">
                {note}
              </p>
            ))}
            {result.replacedLines.length > 0 ? (
              <div className="max-h-40 overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  <caption className="sr-only">{t`Lines replaced by a later line`}</caption>
                  <thead className="bg-muted text-left">
                    <tr>
                      <th className="px-2 py-1">{t`Row`}</th>
                      <th className="px-2 py-1">{t`Replaced by row`}</th>
                      <th className="px-2 py-1">{t`Key`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.replacedLines.map((item) => (
                      <tr key={item.line} className="border-t border-border">
                        <td className="px-2 py-1 tabular-nums">{item.line}</td>
                        <td className="px-2 py-1 tabular-nums">{item.by}</td>
                        <td className="px-2 py-1 font-mono">{item.key}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {result.errors.length > 0 ? (
              <div className="max-h-64 overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted text-left">
                    <tr>
                      <th className="px-2 py-1">{t`Row`}</th>
                      <th className="px-2 py-1">{t`Column`}</th>
                      <th className="px-2 py-1">{t`Value`}</th>
                      <th className="px-2 py-1">{t`Problem`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((error, index) => (
                      <tr key={index} className="border-t border-border">
                        <td className="px-2 py-1 tabular-nums">{error.line}</td>
                        <td className="px-2 py-1">{error.column}</td>
                        <td className="px-2 py-1 font-mono">{error.value}</td>
                        <td className="px-2 py-1">
                          {error.code
                            ? // Stable code from the job (row_locked) or a
                              // client's database refusal (ADR 0028).
                              errorText({
                                data: {
                                  reason: {
                                    code: error.code,
                                    detail: error.detail,
                                  },
                                },
                              })
                            : t`Invalid value for this type`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <DialogFooter>
              <Button onClick={() => close(false)}>{t`Close`}</Button>
            </DialogFooter>
          </div>
        ) : !preview ? (
          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center gap-2 rounded-sm border-2 border-dashed px-6 py-10 text-center text-sm ${
              dragging ? "border-primary bg-accent" : "border-border"
            }`}
          >
            {busy ? (
              <Spinner />
            ) : (
              <FileUp className="h-8 w-8 text-muted-foreground" aria-hidden />
            )}
            <span className="font-medium">
              {t`Drop a file or click to choose one`}
            </span>
            <span className="text-xs text-muted-foreground">
              {t`CSV, TSV, JSON, or Excel (.xlsx). The first row names the columns.`}
            </span>
            <input
              type="file"
              accept={ACCEPT}
              className="sr-only"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </label>
        ) : null}
        {!running && !result && !preview ? (
          <div className="mt-3 flex flex-col gap-2">
            <Label htmlFor="import-paste">
              {t`Or paste rows copied from a spreadsheet`}
            </Label>
            <textarea
              id="import-paste"
              rows={4}
              className="w-full resize-y rounded-md border border-border bg-card px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={t`The first line names the columns.`}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
            />
            <Button
              variant="outline"
              className="self-end"
              disabled={busy || !pasted.trim()}
              onClick={() => {
                const file = pastedFile(pasted, t`Pasted data`);
                if (file) void upload(file);
              }}
            >
              {t`Use the pasted data`}
            </Button>
          </div>
        ) : null}
        {running || result || !preview ? null : (
          <div className="flex min-h-0 flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              {t`${{ file: preview.filename }}: ${plural(preview.total, { one: "# row found", other: "# rows found" })}.`}
            </p>
            {target.kind === "new" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="import-table-name">{t`Table name`}</Label>
                <Input
                  id="import-table-name"
                  value={tableName}
                  maxLength={100}
                  onChange={(event) => setTableName(event.target.value)}
                />
              </div>
            ) : null}
            <div className="max-h-[42vh] overflow-auto rounded border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-left">
                  <tr>
                    <th className="px-2 py-1.5">{t`File column`}</th>
                    <th className="px-2 py-1.5">{t`Destination`}</th>
                    <th className="px-2 py-1.5">{t`Type`}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.headers.map((header, index) => {
                    const choice = choices[index];
                    if (!choice) return null;
                    const examples = preview.sample
                      .slice(0, 3)
                      .map((cells) => cells[index] ?? "")
                      .filter((value) => value !== "")
                      .join(" · ");
                    return (
                      <tr
                        key={index}
                        className="border-t border-border align-top"
                      >
                        <td className="px-2 py-1.5">
                          <div className="font-medium">{header}</div>
                          <div className="max-w-56 truncate text-muted-foreground">
                            {examples || "—"}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          {target.kind === "new" ? (
                            <div className="flex items-center gap-2">
                              <Checkbox
                                aria-label={t`Import ${{ name: header }}`}
                                checked={choice.target === "new"}
                                onChange={(event) =>
                                  update(index, {
                                    target: event.target.checked ? "new" : "",
                                  })
                                }
                              />
                              <Input
                                aria-label={t`Field name`}
                                className="h-7 text-xs"
                                value={choice.label}
                                maxLength={100}
                                disabled={choice.target !== "new"}
                                onChange={(event) =>
                                  update(index, { label: event.target.value })
                                }
                              />
                            </div>
                          ) : (
                            <Select
                              aria-label={t`Destination of ${{ name: header }}`}
                              className="h-7 text-xs"
                              value={choice.target}
                              onChange={(event) =>
                                update(index, { target: event.target.value })
                              }
                            >
                              <option value="">{t`Skip`}</option>
                              {writable.map((column) => (
                                <option
                                  key={column.name}
                                  value={column.name}
                                  disabled={
                                    choice.target !== column.name &&
                                    usedTargets.includes(column.name)
                                  }
                                >
                                  {column.label}
                                </option>
                              ))}
                              {target.canManage ? (
                                <option value="new">{t`New field`}</option>
                              ) : null}
                            </Select>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {choice.target === "new" ? (
                            <Select
                              aria-label={t`Type of ${{ name: header }}`}
                              className="h-7 text-xs"
                              value={choice.fieldType}
                              onChange={(event) =>
                                update(index, { fieldType: event.target.value })
                              }
                            >
                              {CREATE_TYPES.map((type) => (
                                <option key={type} value={type}>
                                  {t(FIELD_LABELS[type] ?? raw(type))}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <span className="text-muted-foreground">
                              {choice.target
                                ? t(
                                    FIELD_LABELS[
                                      writable.find(
                                        (c) => c.name === choice.target,
                                      )?.fieldType ?? ""
                                    ] ?? raw(""),
                                  )
                                : "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {asksDecimal ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="import-decimal">
                  {t`What separates the decimals in this file?`}
                </Label>
                <Select
                  id="import-decimal"
                  value={decimalMark}
                  onChange={(event) =>
                    setDecimalMark(event.target.value as "" | "." | ",")
                  }
                >
                  <option value="">{t`Not said: refuse 1,234, and read 1.234 with a decimal point`}</option>
                  <option value=".">{t`A point: 1,234 is one thousand two hundred and thirty-four`}</option>
                  <option value=",">{t`A comma: 1,234 is one point two three four`}</option>
                </Select>
                {preview.ambiguousNumbers > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {plural(preview.ambiguousNumbers, {
                      one: "# value can be read in two ways, such as 1,234.",
                      other: "# values can be read in two ways, such as 1,234.",
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
            {decimalMark === "," && preview.ambiguousPoints > 0 ? (
              <p role="status" className="text-xs text-warning">
                {plural(preview.ambiguousPoints, {
                  one: "With a comma for decimals, # value such as 1.234 reads two ways and will be refused: write it 1234 or 1,234.",
                  other:
                    "With a comma for decimals, # values such as 1.234 read two ways and will be refused: write them 1234 or 1,234.",
                })}
              </p>
            ) : null}
            {preview.ambiguousDates > 0 ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="import-day-order">
                  {t`What comes first in this file's dates?`}
                </Label>
                <Select
                  id="import-day-order"
                  value={dayOrder}
                  onChange={(event) =>
                    setDayOrder(event.target.value as "" | DayOrder)
                  }
                >
                  <option value="">{t`Not said: refuse these dates`}</option>
                  <option value="day-first">{t`The day: 03/04/2026 is 3 April`}</option>
                  <option value="month-first">{t`The month: 03/04/2026 is 4 March`}</option>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {plural(preview.ambiguousDates, {
                    one: "# date can be read in two ways, such as 03/04/2026. A field with its own date format follows it.",
                    other:
                      "# dates can be read in two ways, such as 03/04/2026. A field with its own date format follows it.",
                  })}
                </p>
              </div>
            ) : null}
            {preview.encoding === "windows-1252" ? (
              <p role="status" className="text-xs text-warning">
                {t`This file is not in UTF-8: it is read as Windows-1252. Check its accents in the examples above.`}
              </p>
            ) : null}
            {preview.emptyFormulas > 0 ? (
              <p role="status" className="text-xs text-warning">
                {plural(preview.emptyFormulas, {
                  one: "# formula has no stored value: its cell will stay empty.",
                  other:
                    "# formulas have no stored value: their cells will stay empty.",
                })}
              </p>
            ) : null}
            {guardedInText > 0 ? (
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={stripTextGuard}
                  onChange={(event) => setStripTextGuard(event.target.checked)}
                />
                {plural(guardedInText, {
                  one: "Remove the apostrophe before =, +, - or @ in # text value (a CSV export adds it)",
                  other:
                    "Remove the apostrophe before =, +, - or @ in # text values (a CSV export adds it)",
                })}
              </label>
            ) : null}
            {tooLong > 0 ? (
              <p role="status" className="text-xs text-warning">
                {t`Some values are longer than their field holds (4,000 characters for a text, 20,000 for a long text): their rows will be refused and listed, nothing is cut.`}
              </p>
            ) : null}
            {target.kind === "existing" ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="import-upsert">{t`Existing rows`}</Label>
                  <Select
                    id="import-upsert"
                    value={upsertSource}
                    onChange={(event) => setUpsertSource(event.target.value)}
                  >
                    <option value="">{t`Add every row`}</option>
                    {mapped.map(({ source }) => (
                      <option key={source} value={String(source)}>
                        {t`Update when “${{ name: preview.headers[source] ?? "" }}” matches`}
                      </option>
                    ))}
                  </Select>
                </div>
                {target.canManage ? (
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={addOptions}
                      onChange={(event) => setAddOptions(event.target.checked)}
                    />
                    {t`Add missing select options`}
                  </label>
                ) : null}
                {needsReason ? (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="import-reason">
                      {t`Reason for the change`}
                    </Label>
                    <Input
                      id="import-reason"
                      value={reason}
                      maxLength={500}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={reset} disabled={busy}>
                {t`Choose another file`}
              </Button>
              <Button
                onClick={() => void commit()}
                disabled={
                  busy ||
                  mapped.length === 0 ||
                  (target.kind === "new" && !tableName.trim()) ||
                  (needsReason && !reason.trim())
                }
              >
                {busy ? <Spinner /> : null}
                {t`Import ${plural(preview.total, { one: "# row", other: "# rows" })}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
