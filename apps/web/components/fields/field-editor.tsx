import {
  canBeRequired,
  checkFormulaTyped,
  type FieldType,
  isPrimaryType,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Textarea,
} from "@anygriddb/ui";
import { ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useTrackJob } from "../../lib/jobs";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import type { CatalogTable, Collaborator } from "../../lib/types";
import { Earlier } from "../history/earlier";
import { CODE_FIELD_TYPES } from "./field-appearance";
import {
  conversionAsksFirst,
  conversionTimeZone,
  CONVERTIBLE,
  convertsValues,
  DRAFT_SPOT_CONTROLS,
  draftOf,
  draftProblems,
  type FieldDraft,
  type FieldEditorTarget,
  fieldRequest,
  SIDE_TYPES,
  typesOffered,
  UNIQUE_TYPES,
} from "./field-draft";
import { formulaScope, FormulaSettings } from "./field-formula-settings";
import { LookupSettings, NewLinkSettings } from "./field-link-settings";
import {
  ButtonSettings,
  CheckboxSettings,
  CodeSettings,
  DateSettings,
  DurationSettings,
  NumberSettings,
  OptionsSettings,
  PeopleSettings,
  RatingSettings,
} from "./field-settings";
import { FieldTypePicker } from "./field-type-picker";
import { LinkSelectionEditor } from "./link-selection";

export type { FieldEditorTarget } from "./field-draft";

const NO_PEOPLE = new Map<string, Collaborator>();

/** The types whose day is written in a format the field chooses. */
const DATED = new Set([
  "date",
  "datetime",
  "created_time",
  "last_modified_time",
]);

/** A value of a conversion's example, as the dialog writes it. */
function sampleText(value: unknown, empty: string): string {
  if (value === null || value === undefined) return empty;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The dialog that makes a field or changes one: its name and type, the
 * settings of that type, and what holds for any type (unique, primary,
 * required, a reason for every change, a description). What it holds
 * while open is a draft (`field-draft`), which also says what saving it
 * asks of the server.
 */
export function FieldEditor({
  open,
  onOpenChange,
  target,
  table,
  tables,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: FieldEditorTarget;
  table: CatalogTable;
  tables: readonly CatalogTable[];
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const editing = target.mode === "edit" ? target.column : null;
  const isNew = target.mode === "create";
  const [draft, setDraft] = useState(() => draftOf(editing, table, tables));
  const set = (change: Partial<FieldDraft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const { fieldType } = draft;
  // A client's table: its columns are the client's; AnyGridDB adds
  // computed fields always, and storage fields when enrichable.
  const external = table.external !== null;
  const enrichable = table.external?.enrichable === true;
  const enrichmentBlocked = table.external?.enrichmentBlocked ?? null;
  const enrichmentMode = table.external?.enrichment ?? null;
  // A client's table says itself what it requires.
  const requirable = canBeRequired(fieldType as FieldType) && !external;
  // Kept in AnyGridDB's database (ADR 0046): no row label can read it.
  const keptApart = isNew
    ? external &&
      enrichmentMode === "control_plane" &&
      SIDE_TYPES.has(fieldType)
    : editing?.controlPlane === true;
  const linkTarget = editing?.relation
    ? tables.find((item) => item.id === editing.relation?.targetTableId)
    : undefined;
  const track = useTrackJob();
  const [conversion, setConversion] = useState<
    | (RouterOutputs["catalog"]["previewConversion"] & { fieldType: string })
    | null
  >(null);
  // A conversion preview holds for the type it was computed for only.
  const preview = conversion?.fieldType === fieldType ? conversion : null;
  const [busy, setBusy] = useState(false);
  const scope = formulaScope(table, tables, editing?.name);
  // The server would refuse it: a formula that does not parse or type is not sent.
  const formulaBlocked =
    fieldType === "formula" &&
    (!draft.formula.trim() ||
      checkFormulaTyped(draft.formula, scope.refs, scope.typeContext) !== null);
  // Once a save was refused here, each part still missing says so.
  const [tried, setTried] = useState(false);
  const problems = new Set(tried ? draftProblems(draft, isNew) : []);
  const settings = { draft, set, problems };

  /**
   * Whether a change of type must be confirmed first: it would lose or
   * rewrite values, reads days in a zone, runs in the background, or stops
   * something that depends on the field. The dialog says which.
   */
  async function asksFirst(
    name: string,
    config: Record<string, unknown> | undefined,
    timeZone: string,
  ): Promise<boolean> {
    const result = await trpc.catalog.previewConversion.query({
      tableId: table.id,
      name,
      fieldType: fieldType as never,
      config,
      timeZone,
    });
    if (!conversionAsksFirst(result)) return false;
    setConversion({ ...result, fieldType });
    return true;
  }

  async function send() {
    const converted =
      editing && convertsValues(draft, editing) && !preview
        ? editing.name
        : undefined;
    const request = fieldRequest(draft, target, table);
    const timeZone = conversionTimeZone(editing);
    const toConfirm =
      converted !== undefined && request.call === "updateColumn"
        ? { name: converted, config: request.input.config }
        : null;
    try {
      if (toConfirm) {
        const confirmFirst = await asksFirst(
          toConfirm.name,
          toConfirm.config,
          timeZone,
        );
        if (confirmFirst) return;
      }
      let primary: string | undefined;
      switch (request.call) {
        case "addRelation":
          await trpc.catalog.addRelation.mutate(request.input);
          break;
        case "addLookup":
          await trpc.catalog.addLookup.mutate(request.input);
          break;
        case "addRollup":
          await trpc.catalog.addRollup.mutate(request.input);
          break;
        case "addColumn": {
          const created = await trpc.catalog.addColumn.mutate(request.input);
          if (request.makePrimary) primary = created.name;
          break;
        }
        case "updateColumn": {
          const { jobId } = await trpc.catalog.updateColumn.mutate({
            ...request.input,
            timeZone,
          });
          // A large table: the field changes when its job ends.
          if (jobId) {
            void track(jobId, {
              label: t`Converting ${{ field: draft.label.trim() }}`,
              onDone: () => ({ message: t`Field converted` }),
            });
            onOpenChange(false);
            return;
          }
          if (request.makePrimary) primary = request.input.name;
          break;
        }
      }
      if (primary !== undefined) {
        await trpc.catalog.setPrimaryColumn.mutate({
          tableId: table.id,
          name: primary,
        });
      }
      await queryClient.invalidateQueries({
        queryKey: api.catalog.list.queryKey(),
      });
      onOpenChange(false);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  function save() {
    // What the server would refuse without saying which part: said here,
    // under that part, which takes the keyboard.
    const missing = draftProblems(draft, isNew)[0];
    if (missing) {
      setTried(true);
      document.getElementById(DRAFT_SPOT_CONTROLS[missing])?.focus();
      return;
    }
    setBusy(true);
    void send().finally(() => setBusy(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={isNew ? t`New field` : t`Edit field`}
        wide={fieldType === "formula"}
      >
        <div className="flex flex-col gap-3">
          {isNew && external && table.external?.hosted ? (
            <p
              role="status"
              className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
            >
              {t`This table was created in the external source. The field is a column of that table, and the values you type are written there.`}
            </p>
          ) : null}
          {isNew && external && !enrichable ? (
            <p
              role="status"
              className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
            >
              {enrichmentBlocked === "synced"
                ? t`This table is a synced copy: only formulas, lookups, rollups, and buttons can be added. Storage fields need a live table.`
                : enrichmentBlocked === "no_key"
                  ? t`This table has no primary key: only formulas, lookups, rollups, and buttons can be added. Storage fields need a key so rows can be matched.`
                  : t`Only formulas, lookups, rollups, and buttons can be added on this table.`}
            </p>
          ) : null}
          {isNew &&
          external &&
          enrichable &&
          enrichmentMode === "control_plane" ? (
            <p
              role="status"
              className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
            >
              {t`This source has no side schema: the field is kept in AnyGridDB. A view filters on it by value or emptiness; it cannot sort or group, and formulas, automations, and rules do not read it. Fields added once an administrator names a side schema sort and group.`}
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="field-label">{t`Field name`}</Label>
            <Input
              id="field-label"
              autoFocus
              value={draft.label}
              onChange={(event) => set({ label: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="field-type">{t`Type`}</Label>
            <FieldTypePicker
              id="field-type"
              value={fieldType}
              types={typesOffered(editing, table)}
              onChange={(next) => set({ fieldType: next })}
            />
          </div>

          {fieldType === "single_select" || fieldType === "multi_select" ? (
            <OptionsSettings {...settings} />
          ) : null}
          {CODE_FIELD_TYPES.has(fieldType) ? (
            <CodeSettings {...settings} />
          ) : null}
          {fieldType === "boolean" ? <CheckboxSettings {...settings} /> : null}
          {fieldType === "number" ? <NumberSettings {...settings} /> : null}
          {DATED.has(fieldType) ? <DateSettings {...settings} /> : null}
          {fieldType === "rating" ? <RatingSettings {...settings} /> : null}
          {fieldType === "duration" ? <DurationSettings {...settings} /> : null}
          {fieldType === "user" ? <PeopleSettings {...settings} /> : null}
          {fieldType === "button" ? <ButtonSettings {...settings} /> : null}
          {fieldType === "link" && isNew ? (
            <NewLinkSettings {...settings} table={table} tables={tables} />
          ) : null}
          {fieldType === "link" && !isNew && linkTarget ? (
            <LinkSelectionEditor
              value={draft.selection}
              onChange={(selection) => set({ selection })}
              target={linkTarget}
              people={NO_PEOPLE}
            />
          ) : null}
          {fieldType === "lookup" || fieldType === "rollup" ? (
            <LookupSettings
              {...settings}
              table={table}
              tables={tables}
              isNew={isNew}
            />
          ) : null}
          {fieldType === "formula" ? (
            <FormulaSettings
              {...settings}
              table={table}
              editing={editing}
              scope={scope}
            />
          ) : null}

          {UNIQUE_TYPES.has(fieldType) && !external ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.unique}
                onChange={(event) => set({ unique: event.target.checked })}
              />
              {t`Unique values`}
            </label>
          ) : null}
          {isPrimaryType(fieldType as FieldType) && !keptApart ? (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.primary}
                  disabled={Boolean(editing?.isPrimary)}
                  onChange={(event) => set({ primary: event.target.checked })}
                />
                {t`Primary field`}
              </label>
              {editing?.isPrimary ? (
                <p className="text-xs text-muted-foreground">
                  {t`Every table needs a primary field. Choose another field to change it.`}
                </p>
              ) : null}
            </div>
          ) : null}
          {requirable ? (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.required}
                  onChange={(event) => set({ required: event.target.checked })}
                />
                {t`Require a value in every row`}
              </label>
              {draft.required && !editing?.required ? (
                <p className="text-xs text-muted-foreground">
                  {t`Rows already empty here stay so until someone changes this field.`}
                </p>
              ) : null}
            </div>
          ) : null}
          {CONVERTIBLE.has(fieldType) ||
          fieldType === "user" ||
          fieldType === "attachment" ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.requireReason}
                onChange={(event) =>
                  set({ requireReason: event.target.checked })
                }
              />
              {t`Require a reason for every change`}
            </label>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="field-description">{t`Description`}</Label>
            <Textarea
              id="field-description"
              className="min-h-14"
              value={draft.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </div>
          {preview ? (
            <div
              role="alert"
              className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger/10 p-2 text-sm"
            >
              {preview.lost > 0 ? (
                <p>
                  {plural(
                    { lost: preview.lost },
                    {
                      one: `# value out of ${ph({ total: preview.total })} cannot be converted and will be cleared. Save anyway?`,
                      other: `# values out of ${ph({ total: preview.total })} cannot be converted and will be cleared. Save anyway?`,
                    },
                  )}
                </p>
              ) : null}
              {preview.rewritten > 0 ? (
                <p>
                  {plural(
                    { rewritten: preview.rewritten },
                    {
                      one: "# value will be written differently.",
                      other: "# values will be written differently.",
                    },
                  )}
                </p>
              ) : null}
              {preview.sampled ? (
                <p>{t`Counted on the first ${ph({ total: preview.total })} values: the table holds more.`}</p>
              ) : null}
              {preview.timeZone ? (
                <p>{t`Days are read in this time zone: ${ph({ zone: preview.timeZone })}.`}</p>
              ) : null}
              {preview.background ? (
                <p>{t`This table is large: it is converted in the background, and stays read-only until that ends.`}</p>
              ) : null}
              {preview.views.length > 0 ? (
                <p>{t`The filter of these views will no longer apply, and they will show no rows until it is corrected: ${ph({ views: preview.views.map((view) => view.name).join(", ") })}.`}</p>
              ) : null}
              {preview.fields.length > 0 ? (
                <p>{t`These fields will stop computing: ${ph({ fields: preview.fields.map((item) => item.label).join(", ") })}.`}</p>
              ) : null}
              {preview.fieldsElsewhere > 0 ? (
                <p>
                  {plural(
                    { elsewhere: preview.fieldsElsewhere },
                    {
                      one: "# field in a table you cannot read will stop computing.",
                      other:
                        "# fields in tables you cannot read will stop computing.",
                    },
                  )}
                </p>
              ) : null}
              {preview.samples.length > 0 ? (
                <ul className="text-xs">
                  {preview.samples.map((sample, index) => (
                    <li key={index} className="break-words">
                      {sampleText(sample.before, t`empty`)} →{" "}
                      {sampleText(sample.after, t`empty`)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {editing ? (
            <Earlier
              kind="column"
              id={editing.id}
              seen={() => ({
                label: editing.label,
                description: editing.description,
                config: editing.config,
                requireReason: editing.requireReason,
                required: editing.required,
                isUnique: editing.isUnique,
              })}
            />
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t`Cancel`}
            </Button>
            <Button
              disabled={
                busy ||
                formulaBlocked ||
                (!draft.label.trim() &&
                  fieldType !== "link" &&
                  fieldType !== "lookup" &&
                  fieldType !== "rollup")
              }
              onClick={save}
            >
              {preview ? t`Convert` : isNew ? t`Create field` : t`Save`}
            </Button>
          </DialogFooter>
          {editing ? (
            <p className="text-xs text-muted-foreground">
              {t`API key`} : <code>{editing.name}</code>
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
