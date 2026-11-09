import { WRITABLE_TYPES } from "@anygriddb/core";
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
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
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
};

/** The report an import job ends with; missing parts read as empty. */
function importReport(result: Record<string, unknown> | null): ImportReport {
  const number = (key: string) =>
    typeof result?.[key] === "number" ? result[key] : 0;
  const errors = Array.isArray(result?.errors)
    ? (result.errors as ImportReport["errors"])
    : [];
  return {
    inserted: number("inserted"),
    updated: number("updated"),
    failed: number("failed"),
    errors,
  };
}

export type ImportTarget =
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
    setReason("");
    setPasted("");
  }

  function close(open: boolean) {
    if (!open && running) {
      const report = (job: Job) => {
        const counts = importReport(job.result);
        return {
          message: t`${{ inserted: counts.inserted }} rows added, ${{ updated: counts.updated }} updated, ${{ failed: counts.failed }} rejected.`,
        };
      };
      void trackJob(running.jobId, {
        label: t`Importing…`,
        onDone: (job) => {
          props.onDone?.();
          return report(job);
        },
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
            ? t`File too large (20 MB, 10 MB for Excel).`
            : errorText(json),
        );
        return;
      }
      const parsed = json as Preview;
      setPreview(parsed);
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
                label: choice.label.trim() || `Colonne ${source + 1}`,
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
          t`Import cancelled: the ${{ count: job.done }} rows already written are kept.`,
        );
        props.onDone?.();
        close(false);
      } else {
        toast.error(jobError(job));
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
            <p>
              {t`${{ inserted: result.inserted }} rows added, ${{ updated: result.updated }} updated, ${{ failed: result.failed }} rejected.`}
            </p>
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
                            ? // What a client's database refused (ADR 0028).
                              errorText({
                                data: {
                                  reason: {
                                    code: error.code,
                                    detail: error.detail,
                                  },
                                },
                              })
                            : error.message === "Row locked"
                              ? t`Row locked`
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
            className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center text-sm ${
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
              {t`CSV, TSV, JSON, or Excel (.xlsx), up to 100,000 rows. The first row names the columns.`}
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
              {t`${{ file: preview.filename }}: ${{ count: preview.total }} rows found.`}
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
                {t`Import ${{ count: preview.total }} rows`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
