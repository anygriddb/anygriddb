import {
  BOOLEAN_APPEARANCES,
  canBeRequired,
  type FieldType,
  type FilterGroup,
  isPrimaryType,
  isTimeZone,
  type LinkSelection,
  MULTI_SELECT_APPEARANCES,
  type ROLLUP_FNS,
  SIDE_FIELD_TYPES,
  SINGLE_SELECT_APPEARANCES,
  TEXT_APPEARANCES,
} from "@anygriddb/core";
import type { RouterInputs } from "../../lib/trpc";
import type { CatalogColumn, CatalogTable } from "../../lib/types";
import { countConditions } from "../table/filter-builder";
import { CODE_FIELD_TYPES } from "./field-appearance";
import { FIELD_GROUPS } from "./field-meta";

/**
 * An option of a list. `original` is the name it was stored under; `id`
 * tells it apart while the dialog is open, where its name and its place
 * both change.
 */
export type FieldOption = {
  name: string;
  color: string;
  original?: string;
  id?: string;
};

/** The field the dialog makes, or the one it changes. */
export type FieldEditorTarget =
  | { mode: "create"; position?: number }
  | { mode: "edit"; column: CatalogColumn };

/**
 * Everything the field dialog holds while it is open: the field's name
 * and type, and the settings of every type, each kept as its control
 * shows it. Only the settings of the type chosen are sent.
 */
export type FieldDraft = {
  label: string;
  /** The type chosen; a link to make or to change is `link`. */
  fieldType: string;
  description: string;
  requireReason: boolean;
  required: boolean;
  unique: boolean;
  primary: boolean;
  options: FieldOption[];
  /** How its values are drawn, where the type has several ways. */
  appearance: string;
  /** Decimals of a number; empty for as many as it holds. */
  precision: string;
  numberStyle: string;
  currency: string;
  nonNegative: boolean;
  dateFormat: string;
  ratingMax: string;
  ratingIcon: string;
  ratingColor: string;
  durationFormat: string;
  /** A collaborator field takes several people, and tells them. */
  multiple: boolean;
  notify: boolean;
  formula: string;
  buttonLabel: string;
  buttonAction: "open_url" | "run_automation";
  buttonUrl: string;
  buttonColor: string;
  /** A lookup or a rollup: the link it goes through, the field it reads. */
  relation: string;
  targetColumn: string;
  rollupFn: string;
  /** Only the linked rows that match count. */
  linkedFilter: FilterGroup;
  /** A new link: the table it reaches, one row or several, both ways. */
  linkTable: string;
  linkMultiple: boolean;
  twoWay: boolean;
  /** The rows an existing link offers and accepts. */
  selection: LinkSelection | undefined;
};

/** What may be added to a client's table: fields that store nothing. */
const COMPUTED_ON_CLIENT = new Set([
  "formula",
  "lookup",
  "rollup",
  "button",
  "row_id",
]);
/**
 * Fields AnyGridDB keeps beside a client's table, in its side table, when
 * the source has a side schema (ADR 0032).
 */
export const SIDE_TYPES = new Set(SIDE_FIELD_TYPES as readonly string[]);

/** The types whose values can be made unique. */
export const UNIQUE_TYPES = new Set([
  "text",
  "email",
  "url",
  "phone",
  "number",
  "date",
  "datetime",
  "single_select",
]);
/** The types a field is converted between, keeping the values that fit. */
export const CONVERTIBLE = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "color",
  "place",
  "json",
  "single_select",
  "multi_select",
  "number",
  "rating",
  "duration",
  "boolean",
  "date",
  "datetime",
]);

/** The dialog as it opens: a field's settings, or a new field's defaults. */
export function draftOf(
  editing: CatalogColumn | null,
  table: CatalogTable,
  tables: readonly CatalogTable[],
): FieldDraft {
  const config = (editing?.config ?? {}) as Record<string, unknown>;
  const number = (config.number ?? {}) as {
    precision?: number;
    style?: string;
    currency?: string;
  };
  const date = (config.date ?? {}) as { format?: string };
  const button = (config.button ?? {}) as {
    label?: string;
    action?: string;
    url?: string;
    color?: string;
  };
  return {
    label: editing?.label ?? "",
    fieldType: editing
      ? editing.fieldType.startsWith("relation")
        ? "link"
        : editing.fieldType
      : // A client's table takes computed fields first.
        table.external !== null
        ? "formula"
        : "text",
    description: editing?.description ?? "",
    requireReason: editing?.requireReason ?? false,
    required: editing?.required ?? false,
    unique: editing?.isUnique ?? false,
    primary: editing?.isPrimary ?? false,
    options: ((config.options as FieldOption[] | undefined) ?? []).map(
      (option) => ({ ...option, original: option.name, id: option.name }),
    ),
    appearance: (config.appearance as string | undefined) ?? "",
    precision: number.precision === undefined ? "" : String(number.precision),
    numberStyle: number.style ?? "decimal",
    currency: number.currency ?? "EUR",
    nonNegative: config.nonNegative === true,
    dateFormat: date.format ?? "eu",
    ratingMax: String((config.ratingMax as number | undefined) ?? 5),
    ratingIcon: (config.ratingIcon as string | undefined) ?? "star",
    ratingColor: (config.ratingColor as string | undefined) ?? "",
    durationFormat: (config.durationFormat as string | undefined) ?? "h:mm",
    multiple: (config.multiple as boolean | undefined) ?? false,
    notify: (config.notify as boolean | undefined) ?? true,
    formula: editing?.formulaSource ?? "",
    buttonLabel: button.label ?? "",
    buttonAction:
      button.action === "run_automation" ? "run_automation" : "open_url",
    buttonUrl: button.url ?? "",
    buttonColor: button.color ?? "blue",
    relation: (config.relation as string | undefined) ?? "",
    targetColumn: (config.target as string | undefined) ?? "",
    rollupFn: (config.fn as string | undefined) ?? "count",
    linkedFilter: (config.filter as FilterGroup | undefined) ?? {
      conjunction: "and",
      conditions: [],
    },
    linkTable: tables.find((item) => item.id !== table.id)?.id ?? table.id,
    linkMultiple: true,
    twoWay: true,
    selection: config.selectFrom as LinkSelection | undefined,
  };
}

/**
 * The types the dialog offers. A new field takes any type on AnyGridDB's
 * own table; on a client's, a computed one, or one kept beside it when the
 * source allows (`enrichable`). A field being changed keeps its type, or
 * takes another its values can be converted to.
 */
export function typesOffered(
  editing: CatalogColumn | null,
  table: CatalogTable,
): string[] {
  const external = table.external !== null;
  const enrichable = table.external?.enrichable === true;
  return FIELD_GROUPS.flatMap((group) => group.types).filter((type) => {
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
  });
}

/**
 * The options with the one at `index` moved a place up (`-1`) or down
 * (`1`): the order a list offers its choices in, and a kanban its stacks.
 * Unchanged when there is no such place.
 */
export function moveOption(
  options: readonly FieldOption[],
  index: number,
  by: -1 | 1,
): FieldOption[] {
  const to = index + by;
  const moved = options[index];
  const next = [...options];
  if (!moved || to < 0 || to >= options.length) return next;
  next.splice(index, 1);
  next.splice(to, 0, moved);
  return next;
}

/** The code a short text is drawn as, where the field holds one. */
export function codeAppearance(draft: FieldDraft): "qr" | "barcode" | null {
  return CODE_FIELD_TYPES.has(draft.fieldType) &&
    (draft.appearance === "qr" || draft.appearance === "barcode")
    ? draft.appearance
    : null;
}

/** A lookup's or rollup's condition, when it holds one. */
function linkedCondition(draft: FieldDraft): FilterGroup | undefined {
  return countConditions(draft.linkedFilter) > 0
    ? draft.linkedFilter
    : undefined;
}

function optionsOf(draft: FieldDraft): Array<{ name: string; color: string }> {
  return draft.options
    .filter((option) => option.name.trim())
    .map(({ name, color }) => ({ name: name.trim(), color }));
}

function appearanceAmong(
  draft: FieldDraft,
  allowed: readonly string[],
): { appearance?: string } {
  return draft.appearance && allowed.includes(draft.appearance)
    ? { appearance: draft.appearance }
    : {};
}

/**
 * The settings of the type chosen, as the server keeps them. `stored` is
 * what the field holds now: a text's default, given through the API, has
 * no control here and stays.
 */
export function configOf(
  draft: FieldDraft,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const drawnAs = codeAppearance(draft);
  switch (draft.fieldType) {
    case "single_select":
      return {
        options: optionsOf(draft),
        ...appearanceAmong(draft, SINGLE_SELECT_APPEARANCES),
      };
    case "multi_select":
      return {
        options: optionsOf(draft),
        ...appearanceAmong(draft, MULTI_SELECT_APPEARANCES),
      };
    case "boolean":
      return appearanceAmong(draft, BOOLEAN_APPEARANCES);
    case "text":
    case "url":
    case "autonumber":
    case "row_id":
      return {
        ...(draft.fieldType === "text" &&
        typeof stored.defaultValue === "string"
          ? { defaultValue: stored.defaultValue }
          : {}),
        ...(drawnAs ? { appearance: drawnAs } : {}),
      };
    case "number":
      return {
        number: {
          ...(draft.precision === ""
            ? {}
            : { precision: Number(draft.precision) }),
          style: draft.numberStyle,
          ...(draft.numberStyle === "currency"
            ? { currency: draft.currency }
            : {}),
        },
        ...(draft.nonNegative ? { nonNegative: true } : {}),
      };
    case "date":
    case "datetime":
    case "created_time":
    case "last_modified_time":
      return { date: { format: draft.dateFormat } };
    case "rating":
      return {
        ratingMax: Number(draft.ratingMax),
        ...(draft.ratingIcon !== "star"
          ? { ratingIcon: draft.ratingIcon }
          : {}),
        ...(draft.ratingColor ? { ratingColor: draft.ratingColor } : {}),
      };
    case "duration":
      return { durationFormat: draft.durationFormat };
    case "user":
      return {
        multiple: draft.multiple,
        ...(draft.notify ? {} : { notify: false }),
      };
    case "button":
      return {
        button: {
          label: draft.buttonLabel.trim() || draft.label.trim() || "Action",
          color: draft.buttonColor,
          action: draft.buttonAction,
          ...(draft.buttonAction === "open_url"
            ? { url: draft.buttonUrl.trim() }
            : {}),
        },
      };
    default:
      return {};
  }
}

/**
 * What a formula's settings send. They are the server's to keep (its
 * expression, its formats): only how its text is drawn is sent, with the
 * formats it had, and nothing at all when no code is asked for or taken
 * away.
 */
export function formulaConfigOf(
  draft: FieldDraft,
  stored: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const drawnAs = codeAppearance(draft);
  if (
    !drawnAs &&
    !TEXT_APPEARANCES.some((value) => value === stored.appearance)
  )
    return undefined;
  return {
    ...(stored.number ? { number: stored.number } : {}),
    ...(stored.date ? { date: stored.date } : {}),
    ...(drawnAs ? { appearance: drawnAs } : {}),
  };
}

/** Whether changing a field's type asks first how many values it loses. */
export function convertsValues(
  draft: FieldDraft,
  editing: CatalogColumn | null,
): boolean {
  return (
    editing !== null &&
    draft.fieldType !== editing.fieldType &&
    !editing.fieldType.startsWith("relation") &&
    CONVERTIBLE.has(editing.fieldType) &&
    CONVERTIBLE.has(draft.fieldType)
  );
}

/**
 * The zone a conversion between a day and an instant reads days in: the
 * one the person sees them in, their field's own if it has one, else
 * their browser's. Shown in the dialog before anything changes.
 */
export function conversionTimeZone(
  editing: CatalogColumn | null,
  browser: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const own = (editing?.config as { date?: { timeZone?: unknown } } | undefined)
    ?.date?.timeZone;
  if (typeof own === "string" && isTimeZone(own)) return own;
  return isTimeZone(browser) ? browser : "UTC";
}

/** Whether a conversion has anything to say before it is done. */
export function conversionAsksFirst(preview: {
  lost: number;
  rewritten: number;
  timeZone: string | null;
  background: boolean;
  views: readonly unknown[];
  fields: readonly unknown[];
  fieldsElsewhere: number;
}): boolean {
  return (
    preview.lost > 0 ||
    preview.rewritten > 0 ||
    preview.timeZone !== null ||
    preview.background ||
    preview.views.length > 0 ||
    preview.fields.length > 0 ||
    preview.fieldsElsewhere > 0
  );
}

/** What saving the dialog asks of the server. */
export type FieldRequest =
  | { call: "addRelation"; input: RouterInputs["catalog"]["addRelation"] }
  | { call: "addLookup"; input: RouterInputs["catalog"]["addLookup"] }
  | { call: "addRollup"; input: RouterInputs["catalog"]["addRollup"] }
  | {
      call: "addColumn";
      input: RouterInputs["catalog"]["addColumn"];
      /** The new field then names the rows. */
      makePrimary: boolean;
    }
  | {
      call: "updateColumn";
      input: RouterInputs["catalog"]["updateColumn"];
      makePrimary: boolean;
    };

/**
 * What saving the dialog asks of the server: a link, a lookup, or a
 * rollup made by its own call, any other field added with its settings,
 * or the field changed. A client's table says itself what it requires
 * and what is unique: neither is sent for one.
 */
export function fieldRequest(
  draft: FieldDraft,
  target: FieldEditorTarget,
  table: CatalogTable,
): FieldRequest {
  const external = table.external !== null;
  const name = draft.label.trim();
  const { fieldType } = draft;
  const type = fieldType as FieldType;
  const required =
    canBeRequired(type) && !external ? draft.required : undefined;
  const unique =
    UNIQUE_TYPES.has(fieldType) && !external ? draft.unique : undefined;
  const formula = fieldType === "formula";
  if (target.mode === "create") {
    if (fieldType === "link") {
      return {
        call: "addRelation",
        input: {
          tableId: table.id,
          label: name || undefined,
          kind: draft.linkMultiple ? "many_to_many" : "one_to_many",
          targetTableId: draft.linkTable,
          twoWay: draft.twoWay && draft.linkTable !== table.id,
        },
      };
    }
    if (fieldType === "lookup") {
      return {
        call: "addLookup",
        input: {
          tableId: table.id,
          label: name || undefined,
          relation: draft.relation,
          target: draft.targetColumn,
          filter: linkedCondition(draft),
        },
      };
    }
    if (fieldType === "rollup") {
      return {
        call: "addRollup",
        input: {
          tableId: table.id,
          label: name || undefined,
          relation: draft.relation,
          target: draft.targetColumn,
          fn: draft.rollupFn as (typeof ROLLUP_FNS)[number],
          filter: linkedCondition(draft),
        },
      };
    }
    return {
      call: "addColumn",
      input: {
        tableId: table.id,
        position: target.position,
        column: {
          label: name,
          fieldType: fieldType as never,
          description: draft.description || undefined,
          requireReason: draft.requireReason,
          required,
          unique,
          config: (formula
            ? formulaConfigOf(draft, {})
            : configOf(draft, {})) as never,
          formulaSource: formula ? draft.formula : undefined,
        },
      },
      makePrimary: draft.primary && isPrimaryType(type),
    };
  }
  const editing = target.column;
  const stored = editing.config as Record<string, unknown>;
  const converting =
    fieldType !== editing.fieldType &&
    !editing.fieldType.startsWith("relation");
  const renames = draft.options
    .filter(
      (option) => option.original && option.original !== option.name.trim(),
    )
    .map((option) => ({
      from: option.original ?? "",
      to: option.name.trim(),
    }));
  // A link sends its selection only: the server keeps its inverse.
  const selection =
    draft.selection &&
    !(
      "filter" in draft.selection &&
      countConditions(draft.selection.filter) === 0
    )
      ? { selectFrom: draft.selection }
      : {};
  // The server keeps a lookup's link, field, and aggregation.
  const condition = linkedCondition(draft);
  const settings =
    fieldType === "link"
      ? selection
      : fieldType === "lookup" || fieldType === "rollup"
        ? condition
          ? { filter: condition }
          : {}
        : formula
          ? formulaConfigOf(draft, stored)
          : configOf(draft, stored);
  // A field becoming a list with no option named takes them from its values.
  const config =
    converting &&
    (fieldType === "single_select" || fieldType === "multi_select") &&
    optionsOf(draft).length === 0
      ? Object.fromEntries(
          Object.entries(settings ?? {}).filter(([key]) => key !== "options"),
        )
      : settings;
  return {
    call: "updateColumn",
    input: {
      tableId: table.id,
      name: editing.name,
      label: name,
      description: draft.description || null,
      requireReason: draft.requireReason,
      required,
      unique,
      fieldType: converting ? (fieldType as never) : undefined,
      config: config,
      formulaSource: formula ? draft.formula : undefined,
      optionRenames: renames.length > 0 ? renames : undefined,
    },
    makePrimary: draft.primary && !editing.isPrimary && isPrimaryType(type),
  };
}

/** A part of the field dialog that still lacks what the type needs. */
export type DraftSpot = "options" | "relation" | "target" | "buttonUrl";

/** The control each part is answered in, which takes the keyboard. */
export const DRAFT_SPOT_CONTROLS: Record<DraftSpot, string> = {
  options: "field-new-option",
  relation: "lookup-relation",
  target: "lookup-target",
  buttonUrl: "button-url",
};

/**
 * What the dialog still needs before the server can make the field, in
 * the order the dialog shows it: a list without options, a lookup or a
 * rollup without its link or the field it reads, a button that opens no
 * address. The server would refuse each without saying which part.
 */
export function draftProblems(draft: FieldDraft, isNew: boolean): DraftSpot[] {
  switch (draft.fieldType) {
    case "single_select":
    case "multi_select":
      return draft.options.length === 0 ? ["options"] : [];
    case "lookup":
    case "rollup":
      // Once made, a lookup's link and field are no longer the dialog's.
      if (!isNew) return [];
      return [
        ...(draft.relation ? [] : (["relation"] as const)),
        ...(draft.targetColumn ? [] : (["target"] as const)),
      ];
    case "button":
      return draft.buttonAction === "open_url" && !draft.buttonUrl.trim()
        ? ["buttonUrl"]
        : [];
    default:
      return [];
  }
}
