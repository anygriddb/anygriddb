import {
  coerceCellValue,
  type FilterGroup,
  rowError,
  visibleFormFields,
} from "@anygriddb/core";
import { Button, cn, Input, Label, Spinner } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Lock, Search } from "lucide-react";
import { useEffect, useState, type SubmitEvent } from "react";
import { dateFormatOf, editZone, formInstant } from "../../lib/dates";
import { trpc, useTRPC } from "../../lib/trpc";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { CellValueView } from "../fields/cell-value";
import { formPrefill } from "../views/form-prefill";
import { formRedirectAfterSubmit } from "../views/form-redirect";
import { FormFiles } from "../views/form-files";
import { formFileUrl, sendFile, type SentFile } from "../../lib/send-file";
import { FormField, formFieldIds } from "../views/form-field";
import { FieldInput, FORM_TIME_ZONE, formKinds } from "../views/form-view";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { InstanceMark } from "../brand/instance-mark";
import { useLocale } from "../../lib/i18n";

const NO_PEOPLE: ReadonlyMap<string, Collaborator> = new Map();
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type FormField = {
  column: string;
  label?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  showIf?: FilterGroup;
};
type FormConfig = {
  title?: string;
  description?: string;
  submitLabel?: string;
  successMessage?: string;
  redirectUrl?: string;
  allowAnother?: boolean;
  fields?: FormField[];
};

function PublicForm({
  token,
  access,
  columns,
  form,
}: {
  token: string;
  access: string | undefined;
  columns: CatalogColumn[];
  form: FormConfig;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  // A link may fill fields of the form, and hide the ones it fills; the
  // server checks the answer as if it had been typed.
  const [prefill] = useState(() =>
    formPrefill(
      window.location.search,
      columns.filter(
        (column) =>
          !form.fields?.length ||
          form.fields.some((field) => field.column === column.name),
      ),
    ),
  );
  const [values, setValues] = useState<
    Record<string, string | string[] | boolean>
  >(() => prefill.values);
  // The files each attachment field sent, shown by name; the answer names
  // their keys (`values`).
  const [sent, setSent] = useState<Record<string, SentFile[]>>({});
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldOf = (name: string) =>
    form.fields?.find((field) => field.column === name);
  // A changed answer clears what the last submit said about the answers.
  const answer = (name: string, value: string | string[] | boolean) => {
    setError("");
    setValues((current) => ({ ...current, [name]: value }));
  };
  // Fields hidden by their condition are not shown, required, or sent;
  // the server decides the same way.
  const visible = new Set(
    visibleFormFields(
      form.fields?.length
        ? form.fields
        : columns.map((column) => ({ column: column.name })),
      values,
      { kinds: formKinds(columns), timeZone: FORM_TIME_ZONE },
    ),
  );
  const usable = columns.filter(
    (column) => column.fieldType !== "user" && visible.has(column.name),
  );
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError("");
    const out: Record<string, unknown> = {};
    for (const column of usable) {
      const raw = values[column.name];
      const empty =
        raw === undefined ||
        raw === "" ||
        (Array.isArray(raw) && raw.length === 0);
      if (empty) {
        if (fieldOf(column.name)?.required) {
          setError(
            t`“${{ field: fieldOf(column.name)?.label || column.label }}” is required`,
          );
          return;
        }
        continue;
      }
      const value =
        column.fieldType === "datetime" && typeof raw === "string"
          ? formInstant(raw, editZone(dateFormatOf(column)))
          : coerceCellValue(
              {
                fieldType: column.fieldType,
                config: column.config,
              },
              raw,
            );
      if (value === undefined) {
        setError(t`Invalid value for ${{ field: column.label }}`);
        return;
      }
      out[column.name] = value;
    }
    setBusy(true);
    try {
      await trpc.share.submit.mutate({
        token,
        access,
        values: out as never,
        timeZone: FORM_TIME_ZONE,
      });
      if (formRedirectAfterSubmit(form.redirectUrl)) return;
      setDone(true);
      setValues(prefill.values);
      setSent({});
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <CheckCircle2 className="h-10 w-10 text-primary" aria-hidden />
        <p>{form.successMessage || t`Thank you, your response was saved.`}</p>
        {form.allowAnother !== false ? (
          <Button variant="outline" onClick={() => setDone(false)}>
            {t`Submit another response`}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
      {usable
        .filter((column) => !prefill.hidden.has(column.name))
        .map((column) => {
          const field = fieldOf(column.name);
          return (
            <FormField
              key={column.name}
              name={column.name}
              label={field?.label || column.label}
              description={field?.description || column.description}
              required={Boolean(field?.required)}
              labelClassName="text-sm text-foreground"
            >
              {column.fieldType === "attachment" ? (
                <FormFiles
                  id={formFieldIds(column.name).id}
                  labelId={formFieldIds(column.name).label}
                  descriptionId={
                    field?.description || column.description
                      ? formFieldIds(column.name).description
                      : undefined
                  }
                  required={field?.required === true}
                  files={sent[column.name] ?? []}
                  onChange={(files) => {
                    setSent((current) => ({
                      ...current,
                      [column.name]: files,
                    }));
                    answer(
                      column.name,
                      files.map((file) => file.key),
                    );
                  }}
                  send={(file) =>
                    sendFile(
                      formFileUrl(token, column.name),
                      file,
                      access ? { "x-share-access": access } : undefined,
                    )
                  }
                />
              ) : (
                <FieldInput
                  column={column}
                  required={field?.required === true}
                  described={Boolean(field?.description || column.description)}
                  people={NO_PEOPLE}
                  value={
                    values[column.name] ??
                    (column.fieldType === "multi_select"
                      ? []
                      : column.fieldType === "boolean"
                        ? false
                        : "")
                  }
                  onChange={(value) => answer(column.name, value)}
                />
              )}
            </FormField>
          );
        })}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="self-start">
        {form.submitLabel || t`Submit`}
      </Button>
    </form>
  );
}

function PublicRows({
  token,
  access,
  columns,
  allowCopy,
  cards,
  titleColumn,
  cardFields,
}: {
  token: string;
  access: string | undefined;
  columns: CatalogColumn[];
  allowCopy: boolean;
  cards: boolean;
  titleColumn?: string;
  cardFields?: string[];
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const api = useTRPC();
  const [limit, setLimit] = useState(100);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const rows = useQuery(
    api.share.rows.queryOptions({
      token,
      access,
      limit,
      offset: 0,
      search: debounced || undefined,
      timeZone: TIME_ZONE,
    }),
  );
  const primary = columns.find((column) => column.isPrimary) ?? columns[0];
  const titleField =
    (titleColumn
      ? columns.find((column) => column.name === titleColumn)
      : undefined) ?? primary;
  const detailColumns = cardFields?.length
    ? cardFields
        .map((name) => columns.find((column) => column.name === name))
        .filter((column): column is CatalogColumn => Boolean(column))
        .filter((column) => column !== titleField)
    : columns.filter((column) => column !== titleField).slice(0, 5);
  const list = rows.data?.rows ?? [];
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        !allowCopy && "select-none",
      )}
      onCopy={(event) => !allowCopy && event.preventDefault()}
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 opacity-50"
            aria-hidden
          />
          <Input
            aria-label={t`Search`}
            placeholder={t`Search`}
            className="h-8 w-56 pl-7"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {t`${{ count: rows.data?.total ?? 0 }} rows`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {cards ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4 p-4">
            {list.map((row) => (
              <li
                key={String(row.id)}
                className="rounded-sm border border-border bg-card p-3"
              >
                {titleField ? (
                  <p className="truncate font-medium">
                    <CellValueView
                      value={row[titleField.name]}
                      error={rowError(row, titleField.name)}
                      column={titleField}
                      locale={locale}
                      people={NO_PEOPLE}
                    />
                  </p>
                ) : null}
                <dl className="mt-2 flex flex-col gap-1">
                  {detailColumns.map((column) => (
                    <div key={column.name}>
                      <dt className="text-[11px] text-muted-foreground">
                        {column.label}
                      </dt>
                      <dd className="flex min-w-0 text-xs">
                        <CellValueView
                          value={row[column.name]}
                          error={rowError(row, column.name)}
                          column={column}
                          locale={locale}
                          people={NO_PEOPLE}
                          inColumn={false}
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-max min-w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.name}
                    className="border-r border-b border-border px-3 py-2 text-left text-xs font-medium whitespace-nowrap"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={String(row.id)} className="hover:bg-muted/50">
                  {columns.map((column) => (
                    <td
                      key={column.name}
                      className="max-w-80 border-r border-b border-border px-3 py-1.5"
                    >
                      <div
                        className={cn(
                          "flex min-w-0",
                          column.kind === "number" && "justify-end",
                        )}
                      >
                        <CellValueView
                          value={row[column.name]}
                          error={rowError(row, column.name)}
                          column={column}
                          locale={locale}
                          people={NO_PEOPLE}
                          search={debounced}
                        />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : null}
        {rows.data && list.length < rows.data.total ? (
          <div className="flex justify-center p-4">
            <Button
              variant="outline"
              onClick={() =>
                setLimit((current) => Math.min(1000, current + 100))
              }
              disabled={limit >= 1000}
            >
              {t`Show more`}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function readProof(key: string): string | undefined {
  try {
    return window.sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function PublicView({ token }: { token: string }) {
  const { t } = useLingui();
  const api = useTRPC();
  // An access proof outlives a reload of the tab, not the tab itself.
  const proofKey = `ag_share_${token.slice(0, 12)}`;
  const [granted, setGranted] = useState(() => readProof(proofKey));
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [checking, setChecking] = useState(false);
  const opened = useQuery({
    ...api.share.open.queryOptions({ token, access: granted }),
    retry: false,
  });
  // A share without a password hands out its proof on the first read.
  const access = granted ?? opened.data?.access ?? undefined;
  useEffect(() => {
    if (!access) return;
    try {
      window.sessionStorage.setItem(proofKey, access);
    } catch {
      // The access proof then lasts for this page only.
    }
  }, [access, proofKey]);

  async function unlock() {
    setChecking(true);
    try {
      const result = await trpc.share.open.query({ token, password });
      setWrong(result.locked);
      if (!result.locked) setGranted(result.access ?? undefined);
    } catch {
      setWrong(true);
    } finally {
      setChecking(false);
    }
  }

  if (opened.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (opened.isError || !opened.data) {
    return (
      <p className="p-10 text-center text-muted-foreground">
        {t`This link does not exist, has expired, or was revoked.`}
      </p>
    );
  }
  const data = opened.data;
  if (data.locked) {
    return (
      <main className="flex h-screen items-center justify-center p-6">
        <form
          className="flex w-full max-w-sm flex-col gap-3 rounded-sm border border-border bg-card p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void unlock();
          }}
        >
          <Lock className="h-6 w-6 text-primary" aria-hidden />
          <Label htmlFor="share-password">
            {t`This share is password protected.`}
          </Label>
          <Input
            id="share-password"
            type="password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {wrong ? (
            <p role="alert" className="text-sm text-danger">
              {t`Wrong password`}
            </p>
          ) : null}
          <Button type="submit" disabled={checking || !password}>
            {t`Open`}
          </Button>
        </form>
      </main>
    );
  }
  const columns = data.columns as unknown as CatalogColumn[];
  const viewType = data.view.viewType;
  const config = data.view.config as {
    form?: FormConfig;
    titleColumn?: string;
    cardFields?: string[];
  };
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        <InstanceMark className="h-6 w-6" named />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{data.table.name}</p>
          <h1 className="truncate font-semibold">{data.view.name}</h1>
        </div>
      </header>
      {viewType === "form" ? (
        <div className="flex-1 overflow-y-auto bg-muted/40 p-6">
          <div className="mx-auto max-w-xl rounded-sm border border-border bg-card p-6">
            <h2 className="text-xl font-semibold">
              {config.form?.title || data.view.name}
            </h2>
            {config.form?.description ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {config.form.description}
              </p>
            ) : null}
            <PublicForm
              token={token}
              access={access}
              columns={columns}
              form={config.form ?? {}}
            />
          </div>
        </div>
      ) : (
        <PublicRows
          token={token}
          access={access}
          columns={columns}
          allowCopy={data.allowCopy}
          cards={viewType !== "grid"}
          titleColumn={config.titleColumn}
          cardFields={config.cardFields}
        />
      )}
    </main>
  );
}
