import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Spinner,
} from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type DragEvent, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useTrackJob } from "../../lib/jobs";
import { trpc, useTRPC } from "../../lib/trpc";
import { useInvalidateCatalog } from "./sidebar";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { known } from "../../lib/known-text";
import { useSnapshotGaps } from "../../lib/snapshot-report";

type Staged = {
  snapshotId: string;
  name: string;
  tables: number;
  rows: number;
  files: number;
  members: number;
};

/** A workbook's sheets, as its first pass found them (ADR 0078). */
type Workbook = {
  importId: string;
  filename: string;
  sheets: Array<{
    sheet: number;
    name: string;
    hidden: boolean;
    rows: number;
    fields: number;
    formulas: number;
  }>;
};

type Source = "start" | "backup" | "spreadsheet" | "airtable";

const ACCEPT: Partial<Record<Source, string>> = {
  backup: ".json,.zip,application/json,application/zip",
  spreadsheet:
    ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Creates a base, empty or from a built-in template, then opens it. A user
 * without a second factor is sent to the settings first, as the API would
 * refuse. A snapshot (`.anygriddb.json`, its schema alone or an older
 * file, or `.anygriddb.zip` with its rows and files) can also be imported
 * as a new base, and so can a workbook (`.xlsx`), each sheet kept a table.
 */
type NewBaseProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mfaEnrolled: boolean;
};

export function NewBaseDialog(props: NewBaseProps) {
  const { t } = useLingui();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent title={t`New base`} wide>
        {/* Mounted while open only: each opening starts empty. */}
        <NewBaseForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function NewBaseForm(props: NewBaseProps) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const navigate = useNavigate();
  const invalidate = useInvalidateCatalog();
  const track = useTrackJob();
  const snapshotGaps = useSnapshotGaps();
  const fileRef = useRef<HTMLInputElement>(null);
  // Where the base comes from: a starting point (empty or a template), a
  // backup file, a workbook, or an Airtable base read with a token the
  // person gives.
  const [source, setSource] = useState<Source>("start");
  const airtable = source === "airtable";
  const [airtableBase, setAirtableBase] = useState("");
  const [airtableToken, setAirtableToken] = useState("");
  const templates = useQuery({
    ...api.catalog.templates.queryOptions(),
    staleTime: Infinity,
  });
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [restoreMembers, setRestoreMembers] = useState(false);
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [sheets, setSheets] = useState<ReadonlySet<number>>(new Set());

  function pick(id: string, label: string) {
    setStaged(null);
    setTemplate(id);
    // Suggest the template's name until the user types their own.
    setName((current) =>
      current === "" ||
      templates.data?.some((item) => t(known(item.name)) === current)
        ? id
          ? label
          : ""
        : current,
    );
  }

  function requireMfa(): boolean {
    if (props.mfaEnrolled) return true;
    toast.error(
      t`Enable a second factor in your settings before creating a base.`,
    );
    void navigate({ to: "/settings" });
    return false;
  }

  /** A workbook's sheets, read for the person to choose: the shown ones kept. */
  async function uploadWorkbook(file: File) {
    if (!requireMfa()) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const response = await fetch(`/api/import/workbook`, {
        method: "POST",
        body,
      });
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(
          response.status === 413
            ? t`File too large: a spreadsheet takes 64 MB at most.`
            : errorText(json ?? { code: "invalid_import" }),
        );
        return;
      }
      const parsed = json as Workbook;
      setSource("spreadsheet");
      setStaged(null);
      setWorkbook(parsed);
      setSheets(
        new Set(
          parsed.sheets
            .filter((sheet) => !sheet.hidden)
            .map((sheet) => sheet.sheet),
        ),
      );
      setTemplate("");
      setName(parsed.filename.replace(/\.xlsx$/i, "").slice(0, 100));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  /** A dropped or chosen file, read as what it says it is. */
  function take(file: File) {
    if (/\.xlsx$/i.test(file.name)) void uploadWorkbook(file);
    else void upload(file);
  }

  async function upload(file: File) {
    if (!requireMfa()) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const response = await fetch(`/api/snapshot/upload`, {
        method: "POST",
        body,
      });
      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(
          errorText(
            json ?? {
              code:
                response.status === 413
                  ? "too_large_snapshot"
                  : "invalid_snapshot",
            },
          ),
        );
        return;
      }
      const parsed = json as Staged;
      setSource("backup");
      setWorkbook(null);
      setStaged(parsed);
      setTemplate("");
      setName(parsed.name);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (!requireMfa()) return;
    setBusy(true);
    try {
      if (airtable) {
        const { jobId } = await trpc.catalog.importAirtable.mutate({
          base: airtableBase.trim(),
          token: airtableToken.trim(),
          name: name.trim(),
        });
        props.onOpenChange(false);
        const job = await track(jobId, {
          label: t`Import from Airtable`,
          onDone: () => ({ message: t`Base imported from Airtable` }),
        });
        const baseId =
          typeof job.result?.baseId === "string"
            ? job.result.baseId
            : undefined;
        await invalidate();
        if (baseId)
          void navigate({ to: "/b/$baseId", params: { baseId: baseId } });
        return;
      }
      if (source === "spreadsheet" && workbook) {
        const { jobId } = await trpc.catalog.importWorkbook.mutate({
          importId: workbook.importId,
          name: name.trim(),
          sheets: [...sheets].sort((a, b) => a - b),
        });
        props.onOpenChange(false);
        const job = await track(jobId, {
          label: t`Spreadsheet import`,
          onDone: (finished) => {
            const failed = workbookFailures(finished.result);
            if (failed > 0) {
              toast.warning(
                plural(failed, {
                  one: "# row did not fit its field and was left out",
                  other: "# rows did not fit their fields and were left out",
                }),
              );
            }
            return { message: t`Base created` };
          },
        });
        const baseId =
          typeof job.result?.baseId === "string"
            ? job.result.baseId
            : undefined;
        await invalidate();
        if (baseId)
          void navigate({ to: "/b/$baseId", params: { baseId: baseId } });
        return;
      }
      if (staged) {
        const { jobId } = await trpc.catalog.importSnapshot.mutate({
          snapshotId: staged.snapshotId,
          name: name.trim(),
          restoreMembers,
        });
        props.onOpenChange(false);
        const job = await track(jobId, {
          label: t`Base import`,
          onDone: (finished) => {
            const baseId =
              typeof finished.result?.baseId === "string"
                ? finished.result.baseId
                : undefined;
            // What did not come over is said, not left to be found.
            const gaps = snapshotGaps(finished.result);
            if (gaps.length > 0) toast.warning(gaps.join(" · "));
            return baseId
              ? {
                  message: t`Base created`,
                  action: {
                    label: t`Open`,
                    onClick: () => {
                      void invalidate().then(
                        () =>
                          void navigate({
                            to: "/b/$baseId",
                            params: { baseId: baseId },
                          }),
                      );
                    },
                  },
                }
              : { message: t`Base created` };
          },
        });
        const baseId =
          typeof job.result?.baseId === "string"
            ? job.result.baseId
            : undefined;
        await invalidate();
        if (baseId)
          void navigate({ to: "/b/$baseId", params: { baseId: baseId } });
        return;
      }
      const created = await trpc.catalog.createBase.mutate({
        name: name.trim(),
        template: template || undefined,
      });
      await invalidate();
      props.onOpenChange(false);
      void navigate({ to: "/b/$baseId", params: { baseId: created.id } });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const choices = [
    {
      id: "",
      name: t`Empty base`,
      description: t`Start with no table, or import a file.`,
      tables: [] as string[],
    },
    ...(templates.data ?? []).map((item) => ({
      ...item,
      name: t(known(item.name)),
      description: t(known(item.description)),
      tables: item.tables.map((table) => t(known(table))),
    })),
  ];

  function choose(next: Source) {
    setSource(next);
    if (next !== "backup") setStaged(null);
    if (next !== "spreadsheet") setWorkbook(null);
  }

  const dropFile = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) take(file);
    },
  };

  const backToStart = (
    <button
      type="button"
      className="self-start text-sm text-primary underline-offset-2 hover:underline"
      onClick={() => choose("start")}
    >
      {t`Back to the starting points`}
    </button>
  );

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-base-name">{t`Base name`}</Label>
        <Input
          id="new-base-name"
          autoFocus
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {source === "start" ? (
        <>
          <fieldset className="flex min-h-0 flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">
              {t`Starting point`}
            </legend>
            {templates.isLoading ? <Spinner /> : null}
            <div
              role="radiogroup"
              className="grid max-h-[46vh] grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2"
            >
              {choices.map((choice) => (
                <button
                  key={choice.id || "empty"}
                  type="button"
                  role="radio"
                  aria-checked={template === choice.id}
                  onClick={() => pick(choice.id, choice.name)}
                  className={cn(
                    "flex flex-col gap-1 rounded-sm border p-3 text-left text-sm hover:bg-muted",
                    template === choice.id
                      ? "border-primary ring-1 ring-primary"
                      : "border-border",
                  )}
                >
                  <span className="font-medium">{choice.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {choice.description}
                  </span>
                  {choice.tables.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {choice.tables.join(" · ")}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </fieldset>
          {/* A backup dropped here is read at once. */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-dashed px-3 py-2 text-sm",
              dragging
                ? "border-primary bg-accent/40"
                : "border-border text-muted-foreground",
            )}
            {...dropFile}
          >
            <FileUp className="h-4 w-4 shrink-0" aria-hidden />
            <span>{t`Or import a base:`}</span>
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => choose("backup")}
            >
              {t`from a backup file`}
            </button>
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => choose("spreadsheet")}
            >
              {t`from a spreadsheet (.xlsx)`}
            </button>
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => choose("airtable")}
            >
              {t`from Airtable`}
            </button>
          </div>
        </>
      ) : null}
      {source === "backup" ? (
        <div className="flex flex-col gap-2">
          <div
            className={cn(
              "flex flex-col items-center gap-2 rounded-sm border border-dashed p-4 text-center text-sm",
              dragging
                ? "border-primary bg-accent/40"
                : "border-border text-muted-foreground",
            )}
            {...dropFile}
          >
            <FileUp className="h-5 w-5" aria-hidden />
            <p>
              {staged
                ? t`File ready: ${{
                    summary: [
                      plural(staged.tables, {
                        one: `# table`,
                        other: `# tables`,
                      }),
                      plural(staged.rows, { one: `# row`, other: `# rows` }),
                      plural(staged.files, {
                        one: `# file`,
                        other: `# files`,
                      }),
                    ].join(", "),
                  }}. You can change the name above.`
                : t`Drop a backup (.anygriddb.json or .anygriddb.zip) to import a base.`}
            </p>
            {staged && staged.members > 0 ? (
              <label className="flex items-center gap-2 text-left text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={restoreMembers}
                  onChange={(event) => setRestoreMembers(event.target.checked)}
                />
                {plural(staged.members, {
                  one: "Give the member their role back, if they have an account here",
                  other: `Give their role back to the # members who have an account here`,
                })}
              </label>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {t`Choose a file`}
            </Button>
          </div>
          {backToStart}
        </div>
      ) : null}
      {source === "spreadsheet" ? (
        <div className="flex flex-col gap-2">
          <div
            className={cn(
              "flex flex-col items-center gap-2 rounded-sm border border-dashed p-4 text-center text-sm",
              dragging
                ? "border-primary bg-accent/40"
                : "border-border text-muted-foreground",
            )}
            {...dropFile}
          >
            <FileUp className="h-5 w-5" aria-hidden />
            <p>
              {workbook
                ? t`Each sheet you keep becomes a table, its first row that holds something naming its fields. You can change the name above.`
                : t`Drop a workbook (.xlsx) to make a base of its sheets. From Google Sheets: File, Download, Microsoft Excel.`}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {t`Choose a file`}
            </Button>
          </div>
          {workbook ? (
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">
                {t`Sheets to keep`}
              </legend>
              <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
                {workbook.sheets.map((sheet) => (
                  <li key={sheet.sheet}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={sheets.has(sheet.sheet)}
                        onChange={(event) => {
                          const next = new Set(sheets);
                          if (event.target.checked) next.add(sheet.sheet);
                          else next.delete(sheet.sheet);
                          setSheets(next);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{sheet.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {[
                            plural(sheet.rows, {
                              one: "# row",
                              other: "# rows",
                            }),
                            plural(sheet.fields, {
                              one: "# field",
                              other: "# fields",
                            }),
                            sheet.hidden ? t`hidden in the workbook` : null,
                            sheet.formulas > 0
                              ? plural(sheet.formulas, {
                                  one: "# formula, imported as its value",
                                  other: "# formulas, imported as their values",
                                })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
          {backToStart}
        </div>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT[source] ?? ACCEPT.backup}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) take(file);
        }}
      />
      {airtable ? (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-col gap-1">
            <Label htmlFor="airtable-base">{t`Airtable base (address or app… id)`}</Label>
            <Input
              id="airtable-base"
              value={airtableBase}
              placeholder="https://airtable.com/app…"
              onChange={(event) => setAirtableBase(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="airtable-token">{t`Personal access token`}</Label>
            <Input
              id="airtable-token"
              type="password"
              autoComplete="off"
              value={airtableToken}
              placeholder="pat…"
              onChange={(event) => setAirtableToken(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t`Create it in Airtable with data.records:read and schema.bases:read on this base. AnyGridDB uses it, encrypted, for the import only, then forgets it. Attachments, view filters, and rollup calculations do not come over: the report will say so.`}
            </p>
          </div>
          {backToStart}
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          {t`Cancel`}
        </Button>
        <Button
          type="submit"
          disabled={
            busy ||
            !name.trim() ||
            (source === "backup" && !staged) ||
            (source === "spreadsheet" && (!workbook || sheets.size === 0)) ||
            (airtable && (!airtableBase.trim() || !airtableToken.trim()))
          }
        >
          {busy ? <Spinner /> : null}
          {source === "start" ? t`Create` : t`Import`}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Rows a finished workbook import left out, all its sheets together. */
function workbookFailures(result: unknown): number {
  if (!result || typeof result !== "object" || !("report" in result)) return 0;
  const report = result.report;
  if (!report || typeof report !== "object" || !("sheets" in report)) return 0;
  const { sheets } = report;
  if (!Array.isArray(sheets)) return 0;
  return sheets.reduce(
    (sum: number, sheet: unknown) =>
      sum +
      (sheet &&
      typeof sheet === "object" &&
      "failed" in sheet &&
      typeof sheet.failed === "number"
        ? sheet.failed
        : 0),
    0,
  );
}
