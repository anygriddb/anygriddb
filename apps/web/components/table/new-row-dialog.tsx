import { coerceCellValue } from "@anygriddb/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Spinner,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useTRPC } from "../../lib/trpc";
import type { CatalogColumn } from "../../lib/types";
import { isComputedField, isLinkField } from "../fields/field-meta";
import { FormField } from "../views/form-field";
import { FieldInput } from "../views/form-view";
import { dateFormatOf, editZone, formInstant } from "../../lib/dates";
import { useTable } from "./table-context";

type Draft = string | string[] | boolean;

/** Field types the dialog has an input for. */
const INPUTS = new Set([
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
]);

/** A link the new row holds itself: a client's own foreign key. */
function isForwardLink(column: CatalogColumn): boolean {
  return (
    isLinkField(column.fieldType) &&
    column.relation?.kind === "one_to_many" &&
    column.relation.direction === "forward"
  );
}

/** The fields a new row of a client's table may fill, in grid order. */
function newRowFields(columns: readonly CatalogColumn[]) {
  return columns.filter(
    (column) =>
      column.insertable &&
      !column.error &&
      !isComputedField(column.fieldType) &&
      (INPUTS.has(column.fieldType) || isForwardLink(column)),
  );
}

/** One linked row, looked up by its label. */
function LinkInput(props: {
  column: CatalogColumn;
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const { table } = useTable();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [label, setLabel] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const candidates = useQuery(
    api.rows.linkCandidates.queryOptions({
      tableId: table.id,
      column: props.column.name,
      search: debounced || undefined,
      limit: 8,
    }),
  );
  return (
    <div className="flex flex-col gap-1">
      <input
        id={`form-${props.column.name}`}
        className="h-9 rounded-md border border-border bg-card px-3 text-sm"
        placeholder={t`Search a linked row`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {props.value ? (
        <p className="text-xs text-muted-foreground">
          {t`Chosen: ${{ label: label || props.value }}`}
        </p>
      ) : null}
      <ul
        className="flex max-h-32 flex-col overflow-y-auto rounded-md border border-border"
        aria-label={t`Suggested rows for ${{ field: props.column.label }}`}
      >
        {candidates.isLoading ? (
          <li className="flex justify-center p-2">
            <Spinner />
          </li>
        ) : null}
        {(candidates.data?.rows ?? []).map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={item.id === props.value}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => {
                setLabel(item.label);
                props.onChange(item.id === props.value ? "" : item.id);
              }}
            >
              <span className="truncate">{item.label || "—"}</span>
              {item.id === props.value ? (
                <Check className="ml-auto h-4 w-4 text-primary" aria-hidden />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a card or a day already knows of the row, as the inputs hold it. */
function draftsOf(initial: Readonly<Record<string, unknown>>) {
  const drafts: Record<string, Draft> = {};
  for (const [name, value] of Object.entries(initial)) {
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      drafts[name] = value;
    }
  }
  return drafts;
}

/**
 * A new row filled before it is sent: a client's database checks it as a
 * whole (a required value, a linked row), and a table of AnyGridDB's own
 * with a required field refuses an empty row. A row either would refuse
 * is never tried. What is refused is said in a message, and the values
 * stay for another try.
 */
export function NewRowDialog(props: {
  open: boolean;
  columns: readonly CatalogColumn[];
  /** A client's table, whose database decides what a new row needs. */
  external: boolean;
  /** Values a card or a day already gives the row. */
  initial?: Readonly<Record<string, unknown>>;
  onClose: () => void;
  onCreate: (values: Record<string, unknown>) => Promise<string | undefined>;
}) {
  const { t } = useLingui();
  const { people } = useTable();
  const fields = newRowFields(props.columns);
  const [values, setValues] = useState<Record<string, Draft>>(() =>
    draftsOf(props.initial ?? {}),
  );
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const out: Record<string, unknown> = {};
    for (const column of fields) {
      const raw = values[column.name];
      if (
        raw === undefined ||
        raw === "" ||
        (Array.isArray(raw) && raw.length === 0)
      ) {
        if (column.required) {
          toast.error(t`“${{ field: column.label }}” is required`);
          return;
        }
        continue;
      }
      if (isForwardLink(column)) {
        out[column.name] = [raw as string];
        continue;
      }
      const value =
        column.fieldType === "datetime" && typeof raw === "string"
          ? formInstant(raw, editZone(dateFormatOf(column)))
          : coerceCellValue(
              { fieldType: column.fieldType, config: column.config },
              raw,
            );
      if (value === undefined) {
        toast.error(t`Invalid value for ${{ field: column.label }}`);
        return;
      }
      out[column.name] = value;
    }
    setBusy(true);
    try {
      const id = await props.onCreate(out);
      if (id) {
        // The row appears in the grid: that is the confirmation.
        setValues({});
        props.onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        title={t`New row`}
        description={
          props.external
            ? t`The row is added in the client's database, which checks the values. A field left empty takes the database's default.`
            : t`Fields marked with an asterisk need a value before the row is added.`
        }
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {fields.map((column) => (
            <FormField
              key={column.name}
              name={column.name}
              label={column.label}
              required={column.required}
            >
              {isForwardLink(column) ? (
                <LinkInput
                  column={column}
                  value={String(values[column.name] ?? "")}
                  onChange={(id) =>
                    setValues((current) => ({ ...current, [column.name]: id }))
                  }
                />
              ) : (
                <FieldInput
                  column={column}
                  required={column.required}
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
                  people={people}
                />
              )}
            </FormField>
          ))}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : null}
              {t`Add the row`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
