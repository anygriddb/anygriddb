/**
 * An Airtable base as an AnyGridDB snapshot: what Airtable's Web API
 * gives (tables, fields, views, records) becomes tables, fields, links,
 * lookups, views, and rows, and the snapshot import builds the base.
 * What has no equivalent comes with a note in the report, never dropped
 * silently.
 */
import type { BaseSnapshot, SnapshotLink, SnapshotTable } from "./snapshot";
import {
  MAX_SNAPSHOT_TABLES,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
} from "./snapshot";
import { madeNames, type MadeNames } from "./made-names";
import { deriveColumnName } from "./names";
import { OPTION_COLORS, type OptionColor } from "./field-config";
import { parseFormula } from "./formula";
import type { ViewType } from "./view-config";

type AirtableField = {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
};

type AirtableView = { id: string; name: string; type: string };

export type AirtableTable = {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: AirtableField[];
  views: AirtableView[];
};

/** A record, its fields keyed by field id (`returnFieldsByFieldId`). */
export type AirtableRecord = {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
};

/** Why a field or a view did not come over as it was. */
export type AirtableNote =
  | "attachments_as_names"
  | "people_as_text"
  | "rollup_as_values"
  | "formula_as_values"
  | "lookup_as_values"
  | "system_as_values"
  | "unknown_as_text"
  | "button_skipped"
  | "view_settings"
  | "view_skipped";

type AirtableReportItem = {
  table: string;
  field?: string;
  view?: string;
  note: AirtableNote;
};

type Cell = string | number | boolean | null | string[];

/** How a field comes over. */
type Plan =
  | {
      as: "column";
      column: SnapshotTable["columns"][number];
      cell: (value: unknown) => Cell;
    }
  | { as: "link" }
  | { as: "lookup"; relation: string; target: string }
  | { as: "count"; relation: string }
  | { as: "skip" };

/** AnyGridDB's labels: no control characters, no braces, 100 at most. */
function fieldLabel(name: string, fallback: string): string {
  const clean = name
    .replace(/[\p{Cc}{}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || fallback).slice(0, 100);
}

/** Base, table, and view names: a letter or digit first, few signs. */
function plainLabel(name: string, fallback: string): string {
  const clean = name
    .replace(/[^\p{L}\p{N} _.'()&/+:#-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .slice(0, 80)
    .trim();
  return clean || fallback;
}

function unique(label: string, taken: Set<string>, max: number): string {
  let candidate = label;
  for (let index = 2; taken.has(candidate.toLowerCase()); index += 1) {
    const suffix = ` ${String(index)}`;
    candidate = `${label.slice(0, max - suffix.length)}${suffix}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

const COLOR_WORDS: Array<[string, OptionColor]> = [
  ["blue", "blue"],
  ["cyan", "teal"],
  ["teal", "teal"],
  ["green", "green"],
  ["yellow", "yellow"],
  ["orange", "orange"],
  ["red", "red"],
  ["pink", "pink"],
  ["purple", "purple"],
  ["gray", "gray"],
];

function optionColor(color: unknown, index: number): OptionColor {
  const found =
    typeof color === "string"
      ? COLOR_WORDS.find(([word]) => color.startsWith(word))?.[1]
      : undefined;
  return found ?? OPTION_COLORS[index % OPTION_COLORS.length] ?? "gray";
}

function choices(
  field: AirtableField,
): Array<{ name: string; color: OptionColor }> {
  const list = Array.isArray(field.options?.choices)
    ? field.options.choices
    : [];
  const seen = new Set<string>();
  return list.flatMap((choice: unknown, index) => {
    const name =
      choice && typeof choice === "object" && "name" in choice
        ? String(choice.name).trim()
        : "";
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const color = (choice as { color?: unknown }).color;
    return [{ name: name.slice(0, 100), color: optionColor(color, index) }];
  });
}

const CURRENCIES: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  CHF: "CHF",
};

/** A text option of a field, or "". */
function optionText(field: AirtableField, key: string): string {
  const value = field.options?.[key];
  return typeof value === "string" ? value : "";
}

function precision(field: AirtableField): number | undefined {
  const value = field.options?.precision;
  return typeof value === "number" && value >= 0 && value <= 8
    ? value
    : undefined;
}

/* Cells. */

const text = (value: unknown): Cell =>
  value === null || value === undefined
    ? null
    : typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : Array.isArray(value)
          ? value.map((item) => textOf(item)).join(", ")
          : textOf(value);

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.name === "string" && typeof item.email === "string") {
      return `${item.name} <${item.email}>`;
    }
    for (const key of ["name", "email", "filename", "text", "label"]) {
      if (typeof item[key] === "string") return item[key];
    }
  }
  return JSON.stringify(value);
}

const number = (value: unknown): Cell =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const percent = (value: unknown): Cell =>
  typeof value === "number" && Number.isFinite(value)
    ? Number((value * 100).toPrecision(15))
    : null;

const day = (value: unknown): Cell =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;

const instant = (value: unknown): Cell =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

const names = (value: unknown): Cell =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;

/** A field of a computed result (formula, rollup, lookup) kept as values. */
function resultColumn(
  field: AirtableField,
  name: string,
  label: string,
): Extract<Plan, { as: "column" }> {
  const result = field.options?.result as { type?: string } | undefined;
  switch (result?.type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "autoNumber":
    case "count":
      return {
        as: "column",
        column: { name, label, fieldType: "number" },
        cell: (value) =>
          result.type === "percent" ? percent(value) : number(value),
      };
    case "checkbox":
      return {
        as: "column",
        column: { name, label, fieldType: "boolean" },
        cell: (value) => (typeof value === "boolean" ? value : null),
      };
    case "date":
      return {
        as: "column",
        column: { name, label, fieldType: "date" },
        cell: day,
      };
    case "dateTime":
      return {
        as: "column",
        column: { name, label, fieldType: "datetime" },
        cell: instant,
      };
    default:
      return {
        as: "column",
        column: { name, label, fieldType: "long_text" },
        cell: text,
      };
  }
}

function viewType(type: string): ViewType | undefined {
  switch (type) {
    case "grid":
    case "form":
    case "kanban":
    case "calendar":
    case "gallery":
    case "timeline":
      return type;
    case "gantt":
      return "timeline";
    default:
      return undefined;
  }
}

/** The snapshot of an Airtable base, and what did not come over as it was. */
export function airtableToSnapshot(input: {
  name: string;
  tables: readonly AirtableTable[];
  records: ReadonlyMap<string, readonly AirtableRecord[]>;
  /** Names for what Airtable left unnamed; English by default. */
  names?: MadeNames;
}): { snapshot: BaseSnapshot; report: AirtableReportItem[] } {
  const made = input.names ?? madeNames();
  const report: AirtableReportItem[] = [];
  const tables = input.tables.slice(0, MAX_SNAPSHOT_TABLES);
  const keyOf = new Map(
    tables.map((table, index) => [table.id, `t${String(index + 1)}`]),
  );
  const tableNames = new Set<string>();
  const tableLabel = new Map(
    tables.map((table, index) => [
      table.id,
      unique(
        plainLabel(table.name, `Table ${String(index + 1)}`),
        tableNames,
        80,
      ),
    ]),
  );
  // Every field's name and label first: links and lookups name the other end.
  const fieldName = new Map<string, string>();
  const fieldLabelOf = new Map<string, string>();
  const fieldTable = new Map<string, string>();
  for (const table of tables) {
    const takenNames = new Set<string>();
    const takenLabels = new Set<string>();
    for (const field of table.fields) {
      const label = unique(
        fieldLabel(field.name, made.field),
        takenLabels,
        100,
      );
      fieldLabelOf.set(field.id, label);
      fieldName.set(field.id, deriveColumnName(label, takenNames));
      takenNames.add(fieldName.get(field.id) ?? "");
      fieldTable.set(field.id, table.id);
    }
  }
  const fieldById = new Map(
    tables.flatMap((table) =>
      table.fields.map((field) => [field.id, field] as const),
    ),
  );
  const plain = (fieldId: string) => {
    const field = fieldById.get(fieldId);
    return field
      ? !PLAN_COMPUTED.has(field.type) && field.type !== "multipleRecordLinks"
      : false;
  };

  const plans = new Map<string, Plan>();
  const plan = (table: AirtableTable, field: AirtableField): Plan => {
    const name = fieldName.get(field.id) ?? "champ";
    const label = fieldLabelOf.get(field.id) ?? made.field;
    const note = (what: AirtableNote) =>
      report.push({ table: table.name, field: field.name, note: what });
    const column = (
      definition: Omit<SnapshotTable["columns"][number], "name" | "label">,
      cell: (value: unknown) => Cell,
    ): Plan => ({
      as: "column",
      column: {
        name,
        label,
        ...definition,
        ...(field.description
          ? { description: field.description.slice(0, 1_000) }
          : {}),
      },
      cell,
    });
    switch (field.type) {
      case "singleLineText":
        return column({ fieldType: "text" }, text);
      case "multilineText":
      case "richText":
        return column({ fieldType: "long_text" }, text);
      case "email":
        return column({ fieldType: "email" }, text);
      case "url":
        return column({ fieldType: "url" }, text);
      case "phoneNumber":
        return column({ fieldType: "phone" }, text);
      case "barcode":
        return column({ fieldType: "text" }, text);
      case "number":
        return column(
          {
            fieldType: "number",
            config: {
              number: {
                ...(precision(field) === undefined
                  ? {}
                  : { precision: precision(field) }),
              },
            },
          },
          number,
        );
      case "currency": {
        const symbol =
          typeof field.options?.symbol === "string"
            ? field.options.symbol.trim()
            : "";
        const code = CURRENCIES[symbol];
        return column(
          {
            fieldType: "number",
            config: {
              number: {
                ...(precision(field) === undefined
                  ? {}
                  : { precision: precision(field) }),
                ...(code ? { style: "currency", currency: code } : {}),
              },
            },
          },
          number,
        );
      }
      case "percent":
        return column(
          { fieldType: "number", config: { number: { style: "percent" } } },
          percent,
        );
      case "checkbox":
        return column({ fieldType: "boolean" }, (value) => value === true);
      case "singleSelect":
        return column(
          { fieldType: "single_select", config: { options: choices(field) } },
          (value) =>
            typeof value === "string" ? value.trim().slice(0, 100) : null,
        );
      case "multipleSelects":
        return column(
          { fieldType: "multi_select", config: { options: choices(field) } },
          names,
        );
      case "date":
        return column({ fieldType: "date" }, day);
      case "dateTime":
        return column({ fieldType: "datetime" }, instant);
      case "rating": {
        const max =
          typeof field.options?.max === "number"
            ? Math.min(10, Math.max(1, field.options.max))
            : 5;
        return column(
          { fieldType: "rating", config: { ratingMax: max } },
          number,
        );
      }
      case "duration":
        return column({ fieldType: "duration" }, number);
      case "createdTime":
      case "lastModifiedTime":
        // As values: AnyGridDB's own times would be those of the import.
        note("system_as_values");
        return column({ fieldType: "datetime" }, instant);
      case "autoNumber":
        note("system_as_values");
        return column({ fieldType: "number" }, number);
      case "singleCollaborator":
      case "multipleCollaborators":
      case "createdBy":
      case "lastModifiedBy":
        note("people_as_text");
        return column({ fieldType: "text" }, text);
      case "multipleAttachments":
        note("attachments_as_names");
        return column({ fieldType: "long_text" }, (value) =>
          Array.isArray(value) ? value.map(textOf).join("\n") : null,
        );
      case "button":
        note("button_skipped");
        return { as: "skip" };
      case "multipleRecordLinks":
        return keyOf.has(optionText(field, "linkedTableId"))
          ? { as: "link" }
          : (note("unknown_as_text"), column({ fieldType: "long_text" }, text));
      case "multipleLookupValues": {
        const relation = optionText(field, "recordLinkFieldId");
        const target = optionText(field, "fieldIdInLinkedTable");
        const relationName = fieldName.get(relation);
        const targetName = fieldName.get(target);
        if (
          relationName &&
          targetName &&
          plain(target) &&
          fieldTable.get(relation) === table.id
        ) {
          return { as: "lookup", relation: relationName, target: targetName };
        }
        note("lookup_as_values");
        return resultColumn(field, name, label);
      }
      case "count": {
        const relation = fieldName.get(optionText(field, "recordLinkFieldId"));
        if (relation) return { as: "count", relation };
        note("rollup_as_values");
        return resultColumn(field, name, label);
      }
      case "rollup":
        // The Web API does not give a rollup's aggregation: its values come.
        note("rollup_as_values");
        return resultColumn(field, name, label);
      case "formula": {
        const source =
          typeof field.options?.formula === "string"
            ? field.options.formula
            : "";
        const converted = formulaSource(
          source,
          table,
          fieldById,
          fieldLabelOf,
          plain,
        );
        if (converted !== undefined) {
          try {
            parseFormula(
              converted,
              table.fields.map((item) => ({
                name: fieldName.get(item.id) ?? "",
                label: fieldLabelOf.get(item.id) ?? "",
              })),
            );
            return {
              as: "column",
              column: {
                name,
                label,
                fieldType: "formula",
                formulaSource: converted,
              },
              cell: () => null,
            };
          } catch {
            // Read as values below.
          }
        }
        note("formula_as_values");
        return resultColumn(field, name, label);
      }
      default:
        note("unknown_as_text");
        return column({ fieldType: "long_text" }, text);
    }
  };
  for (const table of tables) {
    for (const field of table.fields) plans.set(field.id, plan(table, field));
  }

  // Links: one per pair of fields that point at each other.
  const links: SnapshotLink[] = [];
  const paired = new Set<string>();
  for (const table of tables) {
    for (const field of table.fields) {
      if (plans.get(field.id)?.as !== "link" || paired.has(field.id)) continue;
      const target = optionText(field, "linkedTableId");
      const inverseId =
        typeof field.options?.inverseLinkFieldId === "string"
          ? field.options.inverseLinkFieldId
          : undefined;
      const inverse =
        inverseId && target !== table.id && fieldById.has(inverseId)
          ? inverseId
          : undefined;
      paired.add(field.id);
      if (inverse) paired.add(inverse);
      const rows = (input.records.get(table.id) ?? []).flatMap((record) => {
        const to = names(record.fields[field.id]);
        return Array.isArray(to) && to.length > 0
          ? [{ from: record.id, to: to.slice(0, 500) }]
          : [];
      });
      links.push({
        from: keyOf.get(table.id) ?? "",
        to: keyOf.get(target) ?? "",
        name: fieldName.get(field.id),
        label: fieldLabelOf.get(field.id) ?? "Lien",
        inverseLabel:
          (inverse ? fieldLabelOf.get(inverse) : undefined) ??
          tableLabel.get(table.id) ??
          "Lien",
        ...(inverse ? { inverseName: fieldName.get(inverse) } : {}),
        twoWay: inverse !== undefined,
        multiple: field.options?.prefersSingleRecordLink !== true,
        ...(rows.length > 0 ? { links: rows } : {}),
      });
    }
  }
  // A link's other end Airtable gave without its own field stays one-way;
  // a lookup or count through it reads as values.
  for (const table of tables) {
    for (const field of table.fields) {
      if (plans.get(field.id)?.as === "link" && !paired.has(field.id)) {
        plans.set(field.id, { as: "skip" });
      }
    }
  }
  for (const table of tables) {
    for (const field of table.fields) {
      const planned = plans.get(field.id);
      if (planned?.as !== "lookup" && planned?.as !== "count") continue;
      const relation = table.fields.find(
        (item) => fieldName.get(item.id) === planned.relation,
      );
      if (relation && plans.get(relation.id)?.as === "link") continue;
      report.push({
        table: table.name,
        field: field.name,
        note: planned.as === "lookup" ? "lookup_as_values" : "rollup_as_values",
      });
      plans.set(
        field.id,
        resultColumn(
          field,
          fieldName.get(field.id) ?? "champ",
          fieldLabelOf.get(field.id) ?? made.field,
        ),
      );
    }
  }

  const computed: BaseSnapshot["computed"] = [];
  const snapshotTables: SnapshotTable[] = tables.map((table) => {
    const key = keyOf.get(table.id) ?? "";
    const columns: SnapshotTable["columns"] = [];
    const cells: Array<[string, (value: unknown) => Cell, string]> = [];
    for (const field of table.fields) {
      const planned = plans.get(field.id);
      if (planned?.as === "column") {
        columns.push(planned.column);
        if (planned.column.fieldType !== "formula") {
          cells.push([field.id, planned.cell, planned.column.name ?? ""]);
        }
      } else if (planned?.as === "lookup" || planned?.as === "count") {
        const relationField = table.fields.find(
          (item) => fieldName.get(item.id) === planned.relation,
        );
        const linked = relationField
          ? optionText(relationField, "linkedTableId")
          : "";
        const linkedTable = tables.find((item) => item.id === linked);
        computed.push({
          table: key,
          name: fieldName.get(field.id),
          label: fieldLabelOf.get(field.id) ?? made.field,
          relation: planned.relation,
          target:
            planned.as === "lookup"
              ? planned.target
              : (fieldName.get(linkedTable?.primaryFieldId ?? "") ??
                planned.relation),
          ...(planned.as === "count" ? { fn: "count" as const } : {}),
        });
      }
    }
    // Formulas after the fields they read, which AnyGridDB creates in order.
    columns.sort(
      (a, b) =>
        Number(a.fieldType === "formula") - Number(b.fieldType === "formula"),
    );
    if (columns.length === 0) {
      columns.push({
        name: made.name.toLowerCase(),
        label: made.name,
        fieldType: "text",
      });
    }
    const primaryName = fieldName.get(table.primaryFieldId);
    const primary = columns.some((column) => column.name === primaryName)
      ? primaryName
      : columns[0]?.name;
    const viewNames = new Set<string>();
    const views = table.views.flatMap((view) => {
      const type = viewType(view.type);
      if (!type) {
        report.push({
          table: table.name,
          view: view.name,
          note: "view_skipped",
        });
        return [];
      }
      return [
        {
          name: unique(plainLabel(view.name, made.view), viewNames, 80),
          viewType: type,
        },
      ];
    });
    if (views.length > 0) {
      report.push({ table: table.name, note: "view_settings" });
    }
    const rows = (input.records.get(table.id) ?? []).map((record) => {
      const row: Record<string, Cell> = { __id: record.id };
      for (const [fieldId, cell, name] of cells) {
        const value = cell(record.fields[fieldId]);
        if (value !== null) row[name] = value;
      }
      return row;
    });
    return {
      key,
      name: tableLabel.get(table.id) ?? key,
      ...(table.description
        ? { description: table.description.slice(0, 1_000) }
        : {}),
      columns: columns.slice(0, 200),
      ...(primary ? { primary } : {}),
      views: views.slice(0, 50),
      rows,
    };
  });

  return {
    snapshot: {
      kind: SNAPSHOT_KIND,
      version: SNAPSHOT_VERSION,
      base: { name: plainLabel(input.name, "Airtable") },
      tables: snapshotTables,
      links,
      computed,
    },
    report,
  };
}

/** Computed fields Airtable gives as values only, or as lookups and rollups. */
const PLAN_COMPUTED = new Set([
  "formula",
  "rollup",
  "count",
  "multipleLookupValues",
  "button",
  "createdTime",
  "lastModifiedTime",
  "autoNumber",
  "createdBy",
  "lastModifiedBy",
]);

/**
 * A formula Airtable writes with field ids (`{fldX}`) or names, written
 * with AnyGridDB's labels; undefined when it reads anything but plain
 * fields of its own table.
 */
function formulaSource(
  source: string,
  table: AirtableTable,
  fields: ReadonlyMap<string, AirtableField>,
  labels: ReadonlyMap<string, string>,
  plain: (fieldId: string) => boolean,
): string | undefined {
  if (!source.trim()) return undefined;
  const byName = new Map(table.fields.map((field) => [field.name, field.id]));
  const state = { fine: true };
  const written = source.replace(/\{([^{}]+)\}/g, (_, reference: string) => {
    const id = fields.has(reference) ? reference : byName.get(reference);
    if (!id || !table.fields.some((field) => field.id === id) || !plain(id)) {
      state.fine = false;
      return "{}";
    }
    return `{${labels.get(id) ?? reference}}`;
  });
  return state.fine ? written : undefined;
}
