import {
  BOOLEAN_APPEARANCES,
  checkFormulaTyped,
  type FilterGroup,
  type FormulaTypeColumn,
  type FormulaTypeContext,
  isPrimaryType,
  limitOf,
  type LinkSelection,
  MULTI_SELECT_APPEARANCES,
  OPTION_COLORS,
  RATING_ICONS,
  SIDE_FIELD_TYPES,
  ROLLUP_FNS,
  rollupFitsTarget,
  SINGLE_SELECT_APPEARANCES,
  type FieldType,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Select,
  Textarea,
} from "@anygriddb/ui";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import type {
  CatalogColumn,
  CatalogTable,
  Collaborator,
} from "../../lib/types";
import { FIELD_GROUPS, FIELD_LABELS, FieldIcon } from "./field-meta";
import { useLingui } from "@lingui/react/macro";
import type { FormulaEditorHandle } from "./formula-editor";
import { FormulaHelpPanel } from "./formula-help-panel";

// CodeMirror loads with the first formula, not with the grid.
const FormulaEditor = lazy(() => import("./formula-editor"));
import { useErrorText } from "../../lib/errors";
import { distinctLimits, useLimitText } from "../../lib/limits";
import { LimitNotice } from "./limit-notice";
import { LinkSelectionEditor } from "./link-selection";
import { countConditions, FilterBuilder } from "../table/filter-builder";

const NO_PEOPLE = new Map<string, Collaborator>();

/** A lookup's or rollup's condition: only the linked rows that match count. */
function LinkedCondition({
  value,
  onChange,
  target,
}: {
  value: FilterGroup;
  onChange: (value: FilterGroup) => void;
  target: CatalogTable;
}) {
  const { t } = useLingui();
  return (
    <div className="col-span-2 flex flex-col gap-1">
      <span className="text-sm font-medium">
        {t`Only the linked rows that match`}
      </span>
      <div className="rounded-md border border-border p-2">
        <FilterBuilder
          group={value}
          columns={target.columns.filter((column) => !column.relation)}
          people={NO_PEOPLE}
          onChange={onChange}
        />
      </div>
    </div>
  );
}
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { raw } from "../../lib/known-text";
import { ph, plural } from "@lingui/core/macro";

type Option = { name: string; color: string; original?: string };

/** What may be added to a client's table: fields that store nothing. */
const COMPUTED_ON_CLIENT = new Set(["formula", "lookup", "rollup", "button"]);
/**
 * Fields AnyGridDB keeps beside a client's table, in its side table, when
 * the source has a side schema (ADR 0032).
 */
const SIDE_TYPES = new Set(SIDE_FIELD_TYPES as readonly string[]);

const UNIQUE_TYPES = new Set([
  "text",
  "email",
  "url",
  "phone",
  "number",
  "date",
  "datetime",
  "single_select",
]);
const CONVERTIBLE = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "single_select",
  "multi_select",
  "number",
  "rating",
  "duration",
  "boolean",
  "date",
  "datetime",
]);

const ROLLUP_LABELS: Record<string, MessageDescriptor> = {
  count: msg`Count of links`,
  counta: msg`Count of values`,
  count_unique: msg`Unique values`,
  sum: msg`Sum`,
  avg: msg`Average`,
  sum_distinct: msg`Sum of distinct values`,
  avg_distinct: msg`Mean of distinct values`,
  std_dev: msg`Standard deviation (sample)`,
  variance: msg`Variance (sample)`,
  std_dev_pop: msg`Standard deviation (population)`,
  variance_pop: msg`Variance (population)`,
  min: msg`Minimum`,
  max: msg`Maximum`,
  and: msg`All true`,
  or: msg`Any true`,
  concatenate: msg`Concatenate`,
  array_unique: msg`Unique list`,
  earliest: msg`Earliest date`,
  latest: msg`Latest date`,
};

export type FieldEditorTarget =
  | { mode: "create"; position?: number }
  | { mode: "edit"; column: CatalogColumn };

function OptionsEditor({
  options,
  onChange,
}: {
  options: Option[];
  onChange: (options: Option[]) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t`Options`}</Label>
      <ul className="flex flex-col gap-1">
        {options.map((option, index) => (
          <li
            key={`${option.original ?? "new"}-${index}`}
            className="flex items-center gap-1.5"
          >
            <GripVertical className="h-3.5 w-3.5 opacity-40" aria-hidden />
            <div className="flex gap-0.5">
              {OPTION_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={color}
                  className={cn(
                    `opt-${color} h-4 w-4 rounded-full border`,
                    option.color === color
                      ? "border-foreground"
                      : "border-transparent",
                  )}
                  onClick={() =>
                    onChange(
                      options.map((item, at) =>
                        at === index ? { ...item, color } : item,
                      ),
                    )
                  }
                />
              ))}
            </div>
            <Input
              className="h-8"
              aria-label={t`Option name`}
              value={option.name}
              onChange={(event) =>
                onChange(
                  options.map((item, at) =>
                    at === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={t`Delete`}
              onClick={() => onChange(options.filter((_, at) => at !== index))}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const name = draft.trim();
          if (!name || options.some((option) => option.name === name)) return;
          onChange([
            ...options,
            {
              name,
              color:
                OPTION_COLORS[options.length % OPTION_COLORS.length] ?? "gray",
            },
          ]);
          setDraft("");
        }}
      >
        <Input
          className="h-8"
          placeholder={t`New option`}
          aria-label={t`New option`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline">
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </form>
    </div>
  );
}

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
  // A client's table: its columns are the client's; AnyGridDB adds
  // computed fields always, and storage fields when enrichable.
  const external = table.external !== null;
  const enrichable = table.external?.enrichable === true;
  const enrichmentBlocked = table.external?.enrichmentBlocked ?? null;
  const enrichmentMode = table.external?.enrichment ?? null;
  const config = (editing?.config ?? {}) as Record<string, unknown>;
  const [label, setLabel] = useState(editing?.label ?? "");
  const [fieldType, setFieldType] = useState<string>(
    editing
      ? editing.fieldType.startsWith("relation")
        ? "link"
        : editing.fieldType
      : external
        ? "formula"
        : "text",
  );
  const [description, setDescription] = useState(editing?.description ?? "");
  const [requireReason, setRequireReason] = useState(
    editing?.requireReason ?? false,
  );
  const [unique, setUnique] = useState(editing?.isUnique ?? false);
  const [primary, setPrimary] = useState(editing?.isPrimary ?? false);
  const [options, setOptions] = useState<Option[]>(
    ((config.options as Option[] | undefined) ?? []).map((option) => ({
      ...option,
      original: option.name,
    })),
  );
  const number = (config.number ?? {}) as {
    precision?: number;
    style?: string;
    currency?: string;
  };
  const [precision, setPrecision] = useState<string>(
    number.precision === undefined ? "" : String(number.precision),
  );
  const [numberStyle, setNumberStyle] = useState(number.style ?? "decimal");
  const [currency, setCurrency] = useState(number.currency ?? "EUR");
  const date = (config.date ?? {}) as { format?: string; hour12?: boolean };
  const [dateFormat, setDateFormat] = useState(date.format ?? "eu");
  const [ratingMax, setRatingMax] = useState(
    String((config.ratingMax as number | undefined) ?? 5),
  );
  const [ratingIcon, setRatingIcon] = useState(
    (config.ratingIcon as string | undefined) ?? "star",
  );
  const [ratingColor, setRatingColor] = useState(
    (config.ratingColor as string | undefined) ?? "",
  );
  const [appearance, setAppearance] = useState(
    (config.appearance as string | undefined) ?? "",
  );
  const [durationFormat, setDurationFormat] = useState(
    (config.durationFormat as string | undefined) ?? "h:mm",
  );
  const [multiple, setMultiple] = useState(
    (config.multiple as boolean | undefined) ?? false,
  );
  const [notify, setNotify] = useState(
    (config.notify as boolean | undefined) ?? true,
  );
  const [formula, setFormula] = useState(editing?.formulaSource ?? "");
  const storedButton = (config.button ?? {}) as {
    label?: string;
    action?: string;
    url?: string;
    color?: string;
  };
  const [buttonLabel, setButtonLabel] = useState(storedButton.label ?? "");
  const [buttonAction, setButtonAction] = useState<
    "open_url" | "run_automation"
  >(storedButton.action === "run_automation" ? "run_automation" : "open_url");
  const [buttonUrl, setButtonUrl] = useState(storedButton.url ?? "");
  const [buttonColor, setButtonColor] = useState(storedButton.color ?? "blue");
  const [relation, setRelation] = useState(
    (config.relation as string | undefined) ?? "",
  );
  const [targetColumn, setTargetColumn] = useState(
    (config.target as string | undefined) ?? "",
  );
  const [rollupFn, setRollupFn] = useState(
    (config.fn as string | undefined) ?? "count",
  );
  const [linkTable, setLinkTable] = useState(
    tables.find((item) => item.id !== table.id)?.id ?? table.id,
  );
  const [linkMultiple, setLinkMultiple] = useState(true);
  const [twoWay, setTwoWay] = useState(true);
  // A lookup's or rollup's condition on the linked rows it reads.
  const [linkedFilter, setLinkedFilter] = useState<FilterGroup>(
    (config.filter as FilterGroup | undefined) ?? {
      conjunction: "and",
      conditions: [],
    },
  );
  const linkedCondition =
    countConditions(linkedFilter) > 0 ? linkedFilter : undefined;
  // The rows an existing link field offers and accepts.
  const [selection, setSelection] = useState<LinkSelection | undefined>(
    config.selectFrom as LinkSelection | undefined,
  );
  const linkTarget = editing?.relation
    ? tables.find((item) => item.id === editing.relation?.targetTableId)
    : undefined;
  const [conversion, setPreview] = useState<{
    fieldType: string;
    total: number;
    lost: number;
  } | null>(null);
  // A conversion preview holds for the type it was computed for only.
  const preview = conversion?.fieldType === fieldType ? conversion : null;
  const [busy, setBusy] = useState(false);
  const formulaEditor = useRef<FormulaEditorHandle>(null);

  const linkColumns = table.columns.filter((column) => column.relation);
  const relationColumn = linkColumns.find((column) => column.name === relation);
  const relationTarget = tables.find(
    (item) => item.id === relationColumn?.relation?.targetTableId,
  );
  // What the client's engine computes differently in a lookup or rollup:
  // the field it reads, and the rollup's own computation.
  const limitText = useLimitText();
  const engine = table.external?.engine;
  const computedLimits =
    fieldType === "lookup" || fieldType === "rollup"
      ? distinctLimits([
          ...(relationTarget?.columns.find(
            (column) => column.name === targetColumn,
          )?.limits ?? []),
          ...(fieldType === "rollup" && engine
            ? [limitOf(engine, rollupFn)].filter((limit) => limit !== null)
            : []),
        ]).map(limitText)
      : [];
  const isNew = target.mode === "create";
  // Kept in AnyGridDB's database (ADR 0046): no row label can read it.
  const keptApart = isNew
    ? external &&
      enrichmentMode === "control_plane" &&
      SIDE_TYPES.has(fieldType)
    : editing?.controlPlane === true;
  const converting =
    editing &&
    fieldType !== editing.fieldType &&
    !editing.fieldType.startsWith("relation");

  const builtConfig = useMemo(() => {
    switch (fieldType) {
      case "single_select":
        return {
          options: options
            .filter((option) => option.name.trim())
            .map(({ name, color }) => ({ name: name.trim(), color })),
          ...(appearance &&
          (SINGLE_SELECT_APPEARANCES as readonly string[]).includes(appearance)
            ? { appearance }
            : {}),
        };
      case "multi_select":
        return {
          options: options
            .filter((option) => option.name.trim())
            .map(({ name, color }) => ({ name: name.trim(), color })),
          ...(appearance &&
          (MULTI_SELECT_APPEARANCES as readonly string[]).includes(appearance)
            ? { appearance }
            : {}),
        };
      case "boolean":
        return {
          ...(appearance &&
          (BOOLEAN_APPEARANCES as readonly string[]).includes(appearance)
            ? { appearance }
            : {}),
        };
      case "number":
        return {
          number: {
            ...(precision === "" ? {} : { precision: Number(precision) }),
            style: numberStyle,
            ...(numberStyle === "currency" ? { currency } : {}),
          },
        };
      case "date":
      case "datetime":
      case "created_time":
      case "last_modified_time":
        return { date: { format: dateFormat } };
      case "rating":
        return {
          ratingMax: Number(ratingMax),
          ...(ratingIcon !== "star" ? { ratingIcon } : {}),
          ...(ratingColor ? { ratingColor } : {}),
        };
      case "duration":
        return { durationFormat };
      case "user":
        return {
          multiple,
          ...(notify ? {} : { notify: false }),
        };
      case "button":
        return {
          button: {
            label: buttonLabel.trim() || label.trim() || "Action",
            color: buttonColor,
            action: buttonAction,
            ...(buttonAction === "open_url" ? { url: buttonUrl.trim() } : {}),
          },
        };
      default:
        return {};
    }
  }, [
    buttonLabel,
    buttonAction,
    buttonUrl,
    buttonColor,
    label,
    fieldType,
    options,
    precision,
    numberStyle,
    currency,
    dateFormat,
    ratingMax,
    ratingIcon,
    ratingColor,
    appearance,
    durationFormat,
    multiple,
    notify,
  ]);

  const formulaRefs = useMemo(
    () =>
      table.columns
        .filter((column) => column.name !== editing?.name)
        .map((column) => ({ name: column.name, label: column.label })),
    [table.columns, editing?.name],
  );
  const formulaTypeContext = useMemo((): FormulaTypeContext => {
    const asTypeColumn = (column: CatalogColumn): FormulaTypeColumn => ({
      id: column.id,
      name: column.name,
      label: column.label,
      fieldType: column.fieldType,
      config: column.config,
      ...(column.controlPlane ? { controlPlane: true } : {}),
      ...(column.relation
        ? {
            relation: {
              kind: column.relation.kind,
              direction: column.relation.direction,
              targetTableId: column.relation.targetTableId,
            },
          }
        : {}),
    });
    return {
      tableId: table.id,
      columns: table.columns.map(asTypeColumn),
      tables: tables.map((item) => ({
        id: item.id,
        columns: item.columns.map(asTypeColumn),
      })),
      engine: table.external?.engine,
      excludeColumn: editing?.name,
    };
  }, [table, tables, editing?.name]);
  // The server would refuse it: a formula that does not parse or type is not sent.
  const formulaBlocked =
    fieldType === "formula" &&
    (!formula.trim() ||
      checkFormulaTyped(formula, formulaRefs, formulaTypeContext) !== null);

  function insertFormula(text: string, options?: { back?: number }) {
    const editor = formulaEditor.current;
    if (editor) editor.insert(text, options);
    else setFormula((current) => current + text);
  }

  async function save() {
    setBusy(true);
    try {
      const name = label.trim();
      if (isNew) {
        if (fieldType === "link") {
          await trpc.catalog.addRelation.mutate({
            tableId: table.id,
            label: name || undefined,
            kind: linkMultiple ? "many_to_many" : "one_to_many",
            targetTableId: linkTable,
            twoWay: twoWay && linkTable !== table.id,
          });
        } else if (fieldType === "lookup") {
          await trpc.catalog.addLookup.mutate({
            tableId: table.id,
            label: name || undefined,
            relation,
            target: targetColumn,
            filter: linkedCondition,
          });
        } else if (fieldType === "rollup") {
          await trpc.catalog.addRollup.mutate({
            tableId: table.id,
            label: name || undefined,
            relation,
            target: targetColumn,
            fn: rollupFn as (typeof ROLLUP_FNS)[number],
            filter: linkedCondition,
          });
        } else {
          const created = await trpc.catalog.addColumn.mutate({
            tableId: table.id,
            position: target.position,
            column: {
              label: name,
              fieldType: fieldType as never,
              description: description || undefined,
              requireReason,
              unique:
                UNIQUE_TYPES.has(fieldType) && !external ? unique : undefined,
              config: fieldType === "formula" ? undefined : builtConfig,
              formulaSource: fieldType === "formula" ? formula : undefined,
            },
          });
          if (primary && isPrimaryType(fieldType as FieldType)) {
            await trpc.catalog.setPrimaryColumn.mutate({
              tableId: table.id,
              name: created.name,
            });
          }
        }
      } else if (editing) {
        if (
          converting &&
          CONVERTIBLE.has(editing.fieldType) &&
          CONVERTIBLE.has(fieldType) &&
          !preview
        ) {
          const result = await trpc.catalog.previewConversion.query({
            tableId: table.id,
            name: editing.name,
            fieldType: fieldType as never,
          });
          if (result.lost > 0) {
            setPreview({ ...result, fieldType });
            return;
          }
        }
        const renames = options
          .filter(
            (option) =>
              option.original && option.original !== option.name.trim(),
          )
          .map((option) => ({
            from: option.original ?? "",
            to: option.name.trim(),
          }));
        const keepsConfig = fieldType === "lookup" || fieldType === "rollup";
        // A link sends its selection only: the server keeps its inverse.
        const kept =
          selection &&
          !("filter" in selection && countConditions(selection.filter) === 0)
            ? { selectFrom: selection }
            : {};
        await trpc.catalog.updateColumn.mutate({
          tableId: table.id,
          name: editing.name,
          label: name,
          description: description || null,
          requireReason,
          unique: UNIQUE_TYPES.has(fieldType) && !external ? unique : undefined,
          fieldType: converting ? (fieldType as never) : undefined,
          config:
            fieldType === "link"
              ? kept
              : keepsConfig
                ? // The server keeps the link, the field, and the aggregation.
                  linkedCondition
                  ? { filter: linkedCondition }
                  : {}
                : fieldType === "formula"
                  ? undefined
                  : builtConfig,
          formulaSource: fieldType === "formula" ? formula : undefined,
          optionRenames: renames.length > 0 ? renames : undefined,
        });
        if (
          primary &&
          !editing.isPrimary &&
          isPrimaryType(fieldType as FieldType)
        ) {
          await trpc.catalog.setPrimaryColumn.mutate({
            tableId: table.id,
            name: editing.name,
          });
        }
      }
      await queryClient.invalidateQueries({
        queryKey: api.catalog.list.queryKey(),
      });
      onOpenChange(false);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const typeChoices = FIELD_GROUPS.map((group) => ({
    label: group.label,
    types: group.types.filter((type) => {
      if (!editing) {
        return (
          !external ||
          COMPUTED_ON_CLIENT.has(type) ||
          (enrichable && SIDE_TYPES.has(type))
        );
      }
      if (external) return type === editing.fieldType;
      if (editing.fieldType.startsWith("relation")) return type === "link";
      if (
        editing.fieldType === "lookup" ||
        editing.fieldType === "rollup" ||
        editing.fieldType === "formula"
      ) {
        return type === editing.fieldType;
      }
      return (
        type === editing.fieldType ||
        (CONVERTIBLE.has(editing.fieldType) && CONVERTIBLE.has(type))
      );
    }),
  })).filter((group) => group.types.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={isNew ? t`New field` : t`Edit field`}
        wide={fieldType === "formula"}
      >
        <div className="flex flex-col gap-3">
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
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="field-type">{t`Type`}</Label>
            <div className="flex items-center gap-2">
              <FieldIcon
                fieldType={
                  fieldType === "link" ? "relation_many_to_many" : fieldType
                }
                className="h-4 w-4 opacity-70"
              />
              <Select
                id="field-type"
                value={fieldType}
                onChange={(event) => setFieldType(event.target.value)}
              >
                {typeChoices.map((group) => (
                  <optgroup key={group.types[0]} label={t(group.label)}>
                    {group.types.map((type) => (
                      <option key={type} value={type}>
                        {type === "link"
                          ? t`Link to another table`
                          : t(FIELD_LABELS[type] ?? raw(type))}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
          </div>

          {fieldType === "single_select" || fieldType === "multi_select" ? (
            <>
              <OptionsEditor options={options} onChange={setOptions} />
              <div className="flex flex-col gap-1">
                <Label htmlFor="field-appearance">{t`Display`}</Label>
                <Select
                  id="field-appearance"
                  value={appearance || "badge"}
                  onChange={(event) =>
                    setAppearance(
                      event.target.value === "badge" ? "" : event.target.value,
                    )
                  }
                >
                  <option value="badge">{t`Coloured badges`}</option>
                  <option value="text">{t`Plain text`}</option>
                  {fieldType === "single_select"
                    ? SINGLE_SELECT_APPEARANCES.filter(
                        (value) => value === "radio",
                      ).map((value) => (
                        <option key={value} value={value}>
                          {t`Radio buttons`}
                        </option>
                      ))
                    : null}
                  {fieldType === "multi_select"
                    ? MULTI_SELECT_APPEARANCES.filter(
                        (value) => value === "checklist",
                      ).map((value) => (
                        <option key={value} value={value}>
                          {t`Checklist`}
                        </option>
                      ))
                    : null}
                </Select>
              </div>
            </>
          ) : null}

          {fieldType === "boolean" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="field-appearance">{t`Display`}</Label>
              <Select
                id="field-appearance"
                value={appearance || "check"}
                onChange={(event) =>
                  setAppearance(
                    event.target.value === "check" ? "" : event.target.value,
                  )
                }
              >
                {BOOLEAN_APPEARANCES.map((value) => (
                  <option key={value} value={value}>
                    {value === "check"
                      ? t`Checkbox`
                      : value === "switch"
                        ? t`Switch`
                        : t`Yes / No`}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {fieldType === "number" ? (
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="number-style">{t`Format`}</Label>
                <Select
                  id="number-style"
                  value={numberStyle}
                  onChange={(event) => setNumberStyle(event.target.value)}
                >
                  <option value="decimal">{t`Decimal`}</option>
                  <option value="percent">{t`Percent`}</option>
                  <option value="currency">{t`Currency`}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="number-precision">{t`Decimals`}</Label>
                <Select
                  id="number-precision"
                  value={precision}
                  onChange={(event) => setPrecision(event.target.value)}
                >
                  <option value="">{t`Auto`}</option>
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </div>
              {numberStyle === "currency" ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="number-currency">{t`Currency`}</Label>
                  <Input
                    id="number-currency"
                    maxLength={3}
                    value={currency}
                    onChange={(event) =>
                      setCurrency(event.target.value.toUpperCase())
                    }
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {fieldType === "date" ||
          fieldType === "datetime" ||
          fieldType === "created_time" ||
          fieldType === "last_modified_time" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="date-format">{t`Date format`}</Label>
              <Select
                id="date-format"
                value={dateFormat}
                onChange={(event) => setDateFormat(event.target.value)}
              >
                <option value="eu">{t`European (31/12/2026)`}</option>
                <option value="us">{t`US (12/31/2026)`}</option>
                <option value="iso">ISO (2026-12-31)</option>
                <option value="long">{t`Long (December 31, 2026)`}</option>
                <option value="relative">{t`Relative (in 3 days)`}</option>
              </Select>
            </div>
          ) : null}

          {fieldType === "rating" ? (
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="rating-max">{t`Maximum rating`}</Label>
                <Select
                  id="rating-max"
                  value={ratingMax}
                  onChange={(event) => setRatingMax(event.target.value)}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rating-icon">{t`Icon`}</Label>
                <Select
                  id="rating-icon"
                  value={ratingIcon}
                  onChange={(event) => setRatingIcon(event.target.value)}
                >
                  {RATING_ICONS.map((value) => (
                    <option key={value} value={value}>
                      {value === "star"
                        ? t`Star`
                        : value === "heart"
                          ? t`Heart`
                          : value === "thumb"
                            ? t`Thumb`
                            : value === "flag"
                              ? t`Flag`
                              : t`Fire`}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rating-color">{t`Colour`}</Label>
                <Select
                  id="rating-color"
                  value={ratingColor}
                  onChange={(event) => setRatingColor(event.target.value)}
                >
                  <option value="">{t`Default`}</option>
                  {OPTION_COLORS.map((color) => (
                    <option key={color} value={color}>
                      {color}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}

          {fieldType === "duration" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="duration-format">{t`Format`}</Label>
              <Select
                id="duration-format"
                value={durationFormat}
                onChange={(event) => setDurationFormat(event.target.value)}
              >
                <option value="h:mm">h:mm</option>
                <option value="h:mm:ss">h:mm:ss</option>
                <option value="d h:mm">d h:mm</option>
              </Select>
            </div>
          ) : null}

          {fieldType === "user" ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={multiple}
                  onChange={(event) => setMultiple(event.target.checked)}
                />
                {t`Allow several people`}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={notify}
                  onChange={(event) => setNotify(event.target.checked)}
                />
                {t`Notify people when they are assigned`}
              </label>
            </div>
          ) : null}

          {fieldType === "button" ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="button-label">{t`Button text`}</Label>
                  <Input
                    id="button-label"
                    maxLength={40}
                    value={buttonLabel}
                    onChange={(event) => setButtonLabel(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{t`Color`}</Label>
                  <div className="flex h-9 items-center gap-1">
                    {OPTION_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={color}
                        aria-pressed={buttonColor === color}
                        className={cn(
                          `opt-${color} h-5 w-5 rounded-full border`,
                          buttonColor === color
                            ? "border-foreground"
                            : "border-transparent",
                        )}
                        onClick={() => setButtonColor(color)}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="button-action">{t`Action`}</Label>
                <Select
                  id="button-action"
                  value={buttonAction}
                  onChange={(event) =>
                    setButtonAction(
                      event.target.value === "run_automation"
                        ? "run_automation"
                        : "open_url",
                    )
                  }
                >
                  <option value="open_url">{t`Open a URL`}</option>
                  <option value="run_automation">{t`Run an automation`}</option>
                </Select>
              </div>
              {buttonAction === "open_url" ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="button-url">{t`URL`}</Label>
                  <Input
                    id="button-url"
                    placeholder="https://example.com/client/{{record_id}}"
                    value={buttonUrl}
                    onChange={(event) => setButtonUrl(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t`Insert a value with ${{ field: `{{${t`field_name`}}}` }} or ${{ id: "{{record_id}}" }}. Only http and https links open.`}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t`Then create an automation triggered by this button, from the view menu.`}
                </p>
              )}
            </div>
          ) : null}

          {fieldType === "link" && isNew ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="link-table">{t`Linked table`}</Label>
                <Select
                  id="link-table"
                  value={linkTable}
                  onChange={(event) => setLinkTable(event.target.value)}
                >
                  {tables.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={linkMultiple}
                  onChange={(event) => setLinkMultiple(event.target.checked)}
                />
                {t`Allow several linked rows`}
              </label>
              {linkTable !== table.id ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={twoWay}
                    onChange={(event) => setTwoWay(event.target.checked)}
                  />
                  {t`Also create the inverse field in the other table`}
                </label>
              ) : null}
            </div>
          ) : null}

          {fieldType === "link" && !isNew && linkTarget ? (
            <LinkSelectionEditor
              value={selection}
              onChange={setSelection}
              target={linkTarget}
              people={NO_PEOPLE}
            />
          ) : null}

          {(fieldType === "lookup" || fieldType === "rollup") && isNew ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="lookup-relation">{t`Through link`}</Label>
                <Select
                  id="lookup-relation"
                  value={relation}
                  onChange={(event) => setRelation(event.target.value)}
                >
                  <option value="">—</option>
                  {linkColumns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="lookup-target">{t`Field to look up`}</Label>
                <Select
                  id="lookup-target"
                  value={targetColumn}
                  onChange={(event) => setTargetColumn(event.target.value)}
                >
                  <option value="">—</option>
                  {(relationTarget?.columns ?? [])
                    .filter((column) => !column.relation)
                    .map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.label}
                      </option>
                    ))}
                </Select>
              </div>
              {fieldType === "rollup" ? (
                <div className="col-span-2 flex flex-col gap-1">
                  <Label htmlFor="rollup-fn">{t`Aggregation`}</Label>
                  <Select
                    id="rollup-fn"
                    value={rollupFn}
                    onChange={(event) => setRollupFn(event.target.value)}
                  >
                    {ROLLUP_FNS.filter((fn) => {
                      // Only what computes on the chosen field's type.
                      const chosen = relationTarget?.columns.find(
                        (column) => column.name === targetColumn,
                      );
                      return (
                        fn === rollupFn ||
                        !chosen ||
                        rollupFitsTarget(fn, chosen.fieldType)
                      );
                    }).map((fn) => (
                      <option key={fn} value={fn}>
                        {t(ROLLUP_LABELS[fn] ?? raw(fn))}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {computedLimits.length > 0 ? (
                <div className="col-span-2">
                  <LimitNotice texts={computedLimits} />
                </div>
              ) : null}
              {relationTarget ? (
                <LinkedCondition
                  value={linkedFilter}
                  onChange={setLinkedFilter}
                  target={relationTarget}
                />
              ) : null}
              {linkColumns.length === 0 ? (
                <p className="col-span-2 text-sm text-muted-foreground">
                  {t`Add a link to another table first.`}
                </p>
              ) : null}
            </div>
          ) : null}

          {(fieldType === "lookup" || fieldType === "rollup") &&
          !isNew &&
          relationTarget ? (
            <LinkedCondition
              value={linkedFilter}
              onChange={setLinkedFilter}
              target={relationTarget}
            />
          ) : null}

          {fieldType === "formula" ? (
            <div className="grid grid-cols-[1fr_16rem] gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t`Formula`}</span>
                <Suspense
                  fallback={
                    <div className="min-h-32 rounded-md border border-border" />
                  }
                >
                  <FormulaEditor
                    handle={formulaEditor}
                    value={formula}
                    onChange={setFormula}
                    refs={formulaRefs}
                    label={t`Formula`}
                    describedBy="formula-help"
                    engine={table.external?.engine}
                    typeContext={formulaTypeContext}
                    saved={
                      editing?.formulaSource
                        ? {
                            source: editing.formulaSource,
                            limits: editing.limits,
                          }
                        : undefined
                    }
                  />
                </Suspense>
                <p id="formula-help" className="text-xs text-muted-foreground">
                  {t`Reference a field with ${{ example: `{${t`Field name`}}` }}. Operators: + - * / % & = != > >= < <=.`}
                </p>
                <div className="flex flex-wrap gap-1">
                  {table.columns
                    .filter((column) => column.name !== editing?.name)
                    .map((column) => (
                      <button
                        key={column.name}
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs hover:bg-muted"
                        onClick={() => insertFormula(`{${column.label}}`)}
                      >
                        <FieldIcon fieldType={column.fieldType} />
                        {column.label}
                      </button>
                    ))}
                </div>
              </div>
              <FormulaHelpPanel onInsert={insertFormula} />
            </div>
          ) : null}

          {UNIQUE_TYPES.has(fieldType) && !external ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={unique}
                onChange={(event) => setUnique(event.target.checked)}
              />
              {t`Unique values`}
            </label>
          ) : null}
          {isPrimaryType(fieldType as FieldType) && !keptApart ? (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={primary}
                  disabled={Boolean(editing?.isPrimary)}
                  onChange={(event) => setPrimary(event.target.checked)}
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
          {CONVERTIBLE.has(fieldType) ||
          fieldType === "user" ||
          fieldType === "attachment" ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={requireReason}
                onChange={(event) => setRequireReason(event.target.checked)}
              />
              {t`Require a reason for every change`}
            </label>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="field-description">{t`Description`}</Label>
            <Textarea
              id="field-description"
              className="min-h-14"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {preview ? (
            <p
              role="alert"
              className="rounded-md border border-danger/40 bg-danger/10 p-2 text-sm"
            >
              {plural(
                { lost: preview.lost },
                {
                  one: `# value out of ${ph({ total: preview.total })} cannot be converted and will be cleared. Save anyway?`,
                  other: `# values out of ${ph({ total: preview.total })} cannot be converted and will be cleared. Save anyway?`,
                },
              )}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t`Cancel`}
            </Button>
            <Button
              disabled={
                busy ||
                formulaBlocked ||
                (!label.trim() &&
                  fieldType !== "link" &&
                  fieldType !== "lookup" &&
                  fieldType !== "rollup")
              }
              onClick={() => void save()}
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
