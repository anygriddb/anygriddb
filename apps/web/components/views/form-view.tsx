import {
  coerceCellValue,
  type FilterGroup,
  type FilterKind,
  misplacedConditionFields,
  visibleFormFields,
  withRequiredFormFields,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  cn,
  DatePicker,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Textarea,
} from "@anygriddb/ui";
import { CheckCircle2, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { useMemo, useState, type SubmitEvent } from "react";
import { formRedirectAfterSubmit } from "./form-redirect";
import { FormFiles } from "./form-files";
import { sendFile, tableFileUrl, type SentFile } from "../../lib/send-file";
import {
  dateFieldLocale,
  dateFormatOf,
  editZone,
  formInstant,
  fromDateValue,
  startingPoint,
  toDateValue,
} from "../../lib/dates";
import { useLocale } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { countConditions, FilterBuilder } from "../table/filter-builder";
import { toast } from "sonner";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { optionsOf } from "../fields/cell-value";
import {
  booleanAppearance,
  singleSelectAppearance,
} from "../fields/field-appearance";
import { RatingControl } from "../fields/rating-control";
import { isEditableColumn } from "../grid/grid-clipboard";
import { useTable } from "../table/table-context";
import { formPrefill } from "./form-prefill";
import type { ViewProps } from "./view-common";
import { useLingui } from "@lingui/react/macro";

type FormField = {
  column: string;
  label?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  /** Shown only when earlier answers match (`visibleFormFields`). */
  showIf?: FilterGroup;
};

/** The browser's time zone: conditions on relative dates read in it. */
export const FORM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Each column's filter kind, as the form's conditions read it. */
export function formKinds(
  columns: readonly CatalogColumn[],
): Map<string, FilterKind> {
  return new Map(columns.map((column) => [column.name, column.kind]));
}
type FormConfig = {
  title?: string;
  description?: string;
  submitLabel?: string;
  successMessage?: string;
  redirectUrl?: string;
  allowAnother?: boolean;
  fields?: FormField[];
};

const SUPPORTED = new Set([
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "email",
  "url",
  "phone",
  "rating",
  "duration",
  "user",
  "attachment",
]);

/** The ids a form field's label and description carry. */
export function formFieldIds(name: string) {
  const id = `form-${name}`;
  return { id, label: `${id}-label`, description: `${id}-description` };
}

/**
 * One answer of a form. It is named by its label and described by its
 * description (`formFieldIds`), and says when it is required.
 */
export function FieldInput({
  column,
  value,
  onChange,
  people,
  required = false,
  described = false,
}: {
  column: CatalogColumn;
  value: string | string[] | boolean;
  onChange: (value: string | string[] | boolean) => void;
  people: ReadonlyMap<string, Collaborator>;
  required?: boolean;
  /** Whether a description is shown under the label. */
  described?: boolean;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const ids = formFieldIds(column.name);
  const id = ids.id;
  const aria = {
    "aria-required": required || undefined,
    "aria-describedby": described ? ids.description : undefined,
  };
  switch (column.fieldType) {
    case "long_text":
      return (
        <Textarea
          id={id}
          {...aria}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "boolean": {
      const appearance = booleanAppearance(column);
      if (appearance === "yes_no") {
        return (
          <Select
            id={id}
            {...aria}
            value={value === true ? "yes" : value === false ? "no" : ""}
            onChange={(event) => {
              const next = event.target.value;
              onChange(next === "yes" ? true : next === "no" ? false : "");
            }}
          >
            <option value="">—</option>
            <option value="yes">{t`Yes`}</option>
            <option value="no">{t`No`}</option>
          </Select>
        );
      }
      if (appearance === "switch") {
        const on = value === true;
        return (
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby={ids.label}
            aria-describedby={aria["aria-describedby"]}
            aria-required={required || undefined}
            className={cn(
              "inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors",
              on ? "bg-primary" : "bg-muted",
            )}
            onClick={() => onChange(!on)}
          >
            <span
              className={cn(
                "h-5 w-5 rounded-full bg-card shadow-sm transition-transform",
                on ? "translate-x-5" : "translate-x-0",
              )}
              aria-hidden
            />
          </button>
        );
      }
      return (
        <Checkbox
          id={id}
          aria-describedby={aria["aria-describedby"]}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    }
    case "single_select":
      if (singleSelectAppearance(column) === "radio") {
        return (
          <div
            id={id}
            role="radiogroup"
            aria-labelledby={ids.label}
            {...aria}
            className="flex flex-col gap-2"
          >
            {optionsOf(column).map((option) => (
              <label
                key={option.name}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name={id}
                  checked={value === option.name}
                  className="accent-primary"
                  onChange={() => onChange(option.name)}
                />
                {option.name}
              </label>
            ))}
          </div>
        );
      }
      return (
        <Select
          id={id}
          {...aria}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {optionsOf(column).map((option) => (
            <option key={option.name}>{option.name}</option>
          ))}
        </Select>
      );
    case "multi_select": {
      const list = Array.isArray(value) ? value : [];
      return (
        <div
          id={id}
          role="group"
          aria-labelledby={ids.label}
          {...aria}
          className="flex flex-wrap gap-3"
        >
          {optionsOf(column).map((option) => (
            <label
              key={option.name}
              className="flex items-center gap-1.5 text-sm"
            >
              <Checkbox
                checked={list.includes(option.name)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...list, option.name]
                      : list.filter((item) => item !== option.name),
                  )
                }
              />
              {option.name}
            </label>
          ))}
        </div>
      );
    }
    case "rating": {
      const rating =
        value === "" || typeof value === "boolean" ? null : Number(value);
      return (
        <RatingControl
          id={id}
          column={column}
          value={Number.isFinite(rating) ? rating : null}
          interactive
          aria-labelledby={ids.label}
          aria-describedby={aria["aria-describedby"]}
          aria-required={required || undefined}
          onChange={(next) => onChange(next === null ? "" : String(next))}
          onCommit={(next) => onChange(next === null ? "" : String(next))}
        />
      );
    }
    case "user": {
      const multiple =
        (column.config as { multiple?: boolean }).multiple === true;
      const picked = Array.isArray(value)
        ? value
        : value
          ? [String(value)]
          : [];
      if (multiple) {
        return (
          <div
            id={id}
            role="group"
            aria-labelledby={ids.label}
            {...aria}
            className="flex flex-col gap-2"
          >
            {[...people.values()].map((person) => {
              const checked = picked.includes(person.id);
              return (
                <label
                  key={person.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={checked}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...picked, person.id]
                          : picked.filter((item) => item !== person.id),
                      )
                    }
                  />
                  {person.displayName}
                </label>
              );
            })}
          </div>
        );
      }
      return (
        <Select
          id={id}
          {...aria}
          value={picked[0] ?? ""}
          onChange={(event) =>
            onChange(event.target.value ? [event.target.value] : [])
          }
        >
          <option value="">—</option>
          {[...people.values()].map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </Select>
      );
    }
    case "date":
    case "datetime": {
      const withTime = column.fieldType === "datetime";
      const format = dateFormatOf(column);
      const zone = editZone(format);
      return (
        <DatePicker
          id={id}
          aria-labelledby={ids.label}
          aria-describedby={aria["aria-describedby"]}
          isRequired={required}
          value={toDateValue(value, withTime, zone)}
          onChange={(next) => onChange(fromDateValue(next, withTime) ?? "")}
          granularity={withTime ? "minute" : "day"}
          hourCycle={
            format.hour12 === undefined ? undefined : format.hour12 ? 12 : 24
          }
          hideTimeZone={!format.timeZone}
          placeholderValue={withTime ? startingPoint(zone) : undefined}
          locale={dateFieldLocale(locale, format.format)}
        />
      );
    }
    default:
      return (
        <Input
          id={id}
          {...aria}
          type={column.fieldType === "email" ? "email" : "text"}
          inputMode={column.kind === "number" ? "decimal" : undefined}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

export function FormView(props: ViewProps) {
  const { t } = useLingui();
  const table = useTable();
  const form = (props.config.form ?? {}) as FormConfig;
  const candidates = props.allColumns.filter(
    (column) => isEditableColumn(column) && SUPPORTED.has(column.fieldType),
  );
  // A field the table requires is on the form, required, unconditioned.
  const fields: FormField[] = withRequiredFormFields(
    form.fields,
    candidates.map((column) => column.name),
    candidates.filter((column) => column.required).map((column) => column.name),
  );
  // A link may fill fields of the form (`?prefill_<field>=`), and hide
  // the ones it fills (`?hide_<field>=true`); they are still sent.
  const [prefill] = useState(() =>
    formPrefill(
      window.location.search,
      fields.flatMap(
        (field) =>
          candidates.find((column) => column.name === field.column) ?? [],
      ),
    ),
  );
  const [values, setValues] = useState<
    Record<string, string | string[] | boolean>
  >(() => prefill.values);
  const session = useSession();
  const me = session.data?.id;
  const kinds = useMemo(() => formKinds(props.allColumns), [props.allColumns]);
  // Fields hidden by their condition are not shown, required, or sent.
  const visible = new Set(
    visibleFormFields(fields, values, {
      kinds,
      timeZone: FORM_TIME_ZONE,
      ...(me ? { me } : {}),
    }),
  );
  const shown = fields
    .filter((field) => visible.has(field.column))
    .flatMap((field) => {
      const column = candidates.find((item) => item.name === field.column);
      return column ? [{ field, column }] : [];
    });
  const misplaced = misplacedConditionFields(fields);
  // The files each attachment field sent, shown by name; the answer names
  // their keys (`values`).
  const [sent, setSent] = useState<Record<string, SentFile[]>>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const patchForm = (next: Partial<FormConfig>) =>
    props.onPatch({ form: { ...form, ...next } });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const out: Record<string, unknown> = {};
    for (const { field, column } of shown) {
      const raw = values[column.name];
      const empty =
        raw === undefined ||
        raw === "" ||
        (Array.isArray(raw) && raw.length === 0);
      if (empty) {
        if (field.required) {
          toast.error(
            t`“${{ field: field.label || column.label }}” is required`,
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
        toast.error(
          t`Invalid value for ${{ field: field.label || column.label }}`,
        );
        return;
      }
      out[column.name] = value;
    }
    setBusy(true);
    try {
      const id = await props.onCreate(out);
      if (id) {
        if (formRedirectAfterSubmit(form.redirectUrl)) return;
        setDone(true);
        setValues(prefill.values);
        setSent({});
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto bg-muted/40 p-6">
        <div className="mx-auto max-w-xl rounded-sm border border-border bg-card p-6">
          {props.canEdit ? (
            <input
              aria-label={t`Form title`}
              className="w-full bg-transparent text-xl font-semibold outline-none"
              defaultValue={form.title ?? ""}
              placeholder={t`Form title`}
              onBlur={(event) =>
                event.target.value !== (form.title ?? "") &&
                patchForm({ title: event.target.value || undefined })
              }
            />
          ) : (
            <h2 className="text-xl font-semibold">{form.title}</h2>
          )}
          {props.canEdit ? (
            <textarea
              aria-label={t`Form description`}
              className="mt-2 w-full resize-none bg-transparent text-sm text-muted-foreground outline-none"
              defaultValue={form.description ?? ""}
              placeholder={t`Description (optional)`}
              onBlur={(event) =>
                event.target.value !== (form.description ?? "") &&
                patchForm({ description: event.target.value || undefined })
              }
            />
          ) : form.description ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {form.description}
            </p>
          ) : null}
          {done ? (
            <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle2 className="h-10 w-10 text-primary" aria-hidden />
              <p>
                {form.successMessage || t`Thank you, your response was saved.`}
              </p>
              {form.allowAnother !== false ? (
                <Button variant="outline" onClick={() => setDone(false)}>
                  {t`Submit another response`}
                </Button>
              ) : null}
            </div>
          ) : (
            <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
              {shown
                .filter(({ column }) => !prefill.hidden.has(column.name))
                .map(({ field, column }) => (
                  <div key={column.name} className="flex flex-col gap-1">
                    <Label
                      id={formFieldIds(column.name).label}
                      htmlFor={formFieldIds(column.name).id}
                      className="text-sm text-foreground"
                    >
                      {field.label || column.label}
                      {field.required ? (
                        <span className="text-danger" aria-hidden>
                          {" "}
                          *
                        </span>
                      ) : null}
                    </Label>
                    {field.description || column.description ? (
                      <p
                        id={formFieldIds(column.name).description}
                        className="text-xs text-muted-foreground"
                      >
                        {field.description || column.description}
                      </p>
                    ) : null}
                    {column.fieldType === "attachment" ? (
                      <FormFiles
                        id={formFieldIds(column.name).id}
                        labelId={formFieldIds(column.name).label}
                        descriptionId={
                          field.description || column.description
                            ? formFieldIds(column.name).description
                            : undefined
                        }
                        required={field.required === true}
                        files={sent[column.name] ?? []}
                        onChange={(files) => {
                          setSent((current) => ({
                            ...current,
                            [column.name]: files,
                          }));
                          setValues((current) => ({
                            ...current,
                            [column.name]: files.map((file) => file.key),
                          }));
                        }}
                        send={(file) =>
                          sendFile(tableFileUrl(table.table.id), file)
                        }
                      />
                    ) : (
                      <FieldInput
                        column={column}
                        required={field.required === true}
                        described={Boolean(
                          field.description || column.description,
                        )}
                        value={
                          values[column.name] ??
                          (column.fieldType === "multi_select"
                            ? []
                            : column.fieldType === "boolean"
                              ? false
                              : "")
                        }
                        onChange={(value) =>
                          setValues((current) => ({
                            ...current,
                            [column.name]: value,
                          }))
                        }
                        people={table.people}
                      />
                    )}
                  </div>
                ))}
              <Button
                type="submit"
                disabled={busy || !props.canEdit}
                className="self-start"
              >
                {form.submitLabel || t`Submit`}
              </Button>
            </form>
          )}
        </div>
      </div>
      {props.canEdit ? (
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-semibold">{t`Form fields`}</h3>
          <ul className="flex flex-col gap-2">
            {[
              ...fields.flatMap((item) => {
                const column = candidates.find(
                  (candidate) => candidate.name === item.column,
                );
                return column ? [column] : [];
              }),
              ...candidates.filter(
                (column) => !fields.some((item) => item.column === column.name),
              ),
            ].map((column) => {
              const field = fields.find((item) => item.column === column.name);
              const included = Boolean(field) && !field?.hidden;
              // The table requires it: the form cannot leave it out.
              const byTable = column.required;
              // A condition reads the fields placed before this one.
              const place = fields.findIndex(
                (item) => item.column === column.name,
              );
              const earlier = fields
                .slice(0, place < 0 ? fields.length : place)
                .filter((item) => !item.hidden)
                .flatMap((item) => {
                  const found = candidates.find(
                    (candidate) => candidate.name === item.column,
                  );
                  return found ? [found] : [];
                });
              const conditions = countConditions(field?.showIf);
              const update = (next: Partial<FormField>) => {
                const base = fields.some((item) => item.column === column.name)
                  ? fields
                  : [...fields, { column: column.name, hidden: true }];
                patchForm({
                  fields: base.map((item) =>
                    item.column === column.name ? { ...item, ...next } : item,
                  ),
                });
              };
              const move = (delta: number) => {
                if (place < 0) return;
                const target = place + delta;
                if (target < 0 || target >= fields.length) return;
                const next = [...fields];
                const [item] = next.splice(place, 1);
                if (!item) return;
                next.splice(target, 0, item);
                patchForm({ fields: next });
              };
              return (
                <li
                  key={column.name}
                  className="flex flex-col gap-1 rounded-md border border-transparent px-0.5 py-0.5 text-sm hover:border-border"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Checkbox
                      checked={included}
                      disabled={byTable}
                      aria-label={t`Include ${{ field: column.label }}`}
                      onChange={(event) =>
                        update({ hidden: !event.target.checked })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {column.label}
                    </span>
                    {place >= 0 ? (
                      <span className="flex items-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          disabled={place === 0}
                          aria-label={t`Move ${{ field: column.label }} up`}
                          onClick={() => move(-1)}
                        >
                          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          disabled={place >= fields.length - 1}
                          aria-label={t`Move ${{ field: column.label }} down`}
                          onClick={() => move(1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </span>
                    ) : null}
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Checkbox
                        checked={field?.required === true}
                        disabled={!included || byTable}
                        onChange={(event) =>
                          update({ required: event.target.checked })
                        }
                      />
                      {t`required`}
                    </label>
                    {included && !byTable && earlier.length > 0 ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            size="icon"
                            variant={conditions > 0 ? "outline" : "ghost"}
                            className="h-6 w-6"
                            aria-label={
                              conditions > 0
                                ? t`Display condition of ${{ field: column.label }}: ${{ count: conditions }}`
                                : t`Show ${{ field: column.label }} on a condition`
                            }
                          >
                            <Filter className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[36rem] max-w-[95vw]">
                          <p className="mb-2 text-xs text-muted-foreground">
                            {t`Show “${{ field: column.label }}” only when earlier answers match:`}
                          </p>
                          <FilterBuilder
                            group={
                              field?.showIf ?? {
                                conjunction: "and",
                                conditions: [],
                              }
                            }
                            columns={earlier}
                            people={table.people}
                            onChange={(group) =>
                              update({
                                showIf:
                                  group.conditions.length > 0
                                    ? group
                                    : undefined,
                              })
                            }
                          />
                        </PopoverContent>
                      </Popover>
                    ) : null}
                  </div>
                  {included ? (
                    <div className="ml-6 flex flex-col gap-1">
                      <Input
                        aria-label={t`Label for ${{ field: column.label }}`}
                        className="h-7 text-xs"
                        defaultValue={field?.label ?? ""}
                        placeholder={column.label}
                        onBlur={(event) => {
                          const value = event.target.value.trim();
                          if (value === (field?.label ?? "")) return;
                          update({ label: value || undefined });
                        }}
                      />
                      <Textarea
                        aria-label={t`Description for ${{ field: column.label }}`}
                        className="min-h-12 text-xs"
                        defaultValue={field?.description ?? ""}
                        placeholder={t`Description (optional)`}
                        onBlur={(event) => {
                          const value = event.target.value.trim();
                          if (value === (field?.description ?? "")) return;
                          update({ description: value || undefined });
                        }}
                      />
                    </div>
                  ) : null}
                  {misplaced.has(column.name) ? (
                    <p className="w-full text-xs text-danger">
                      {t`Its condition reads a field placed after it: it is ignored.`}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex flex-col gap-2">
            <Label htmlFor="form-submit-label">{t`Submit button label`}</Label>
            <Input
              id="form-submit-label"
              defaultValue={form.submitLabel ?? ""}
              placeholder={t`Submit`}
              onBlur={(event) =>
                patchForm({ submitLabel: event.target.value || undefined })
              }
            />
            <Label htmlFor="form-success">{t`Message after submit`}</Label>
            <Textarea
              id="form-success"
              className="min-h-14"
              defaultValue={form.successMessage ?? ""}
              onBlur={(event) =>
                patchForm({ successMessage: event.target.value || undefined })
              }
            />
            <Label htmlFor="form-redirect">{t`Redirect after submit`}</Label>
            <Input
              id="form-redirect"
              type="url"
              inputMode="url"
              placeholder="https://"
              defaultValue={form.redirectUrl ?? ""}
              onBlur={(event) =>
                patchForm({ redirectUrl: event.target.value || undefined })
              }
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.allowAnother !== false}
                onChange={(event) =>
                  patchForm({ allowAnother: event.target.checked })
                }
              />
              {t`Offer to submit another response`}
            </label>
            <p className="text-xs text-muted-foreground">
              {t`A link can fill fields: add ?prefill_field_name=value to its address, and &hide_field_name=true to hide a filled field.`}
            </p>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
