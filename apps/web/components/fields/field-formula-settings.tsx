import type { FormulaTypeColumn, FormulaTypeContext } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useRef } from "react";
import { formulaEngine } from "../../lib/limits";
import type { CatalogColumn, CatalogTable } from "../../lib/types";
import { FieldIcon } from "./field-meta";
import type { SettingsProps } from "./field-settings";
import type { FormulaEditorHandle } from "./formula-editor";
import { FormulaHelpPanel } from "./formula-help-panel";

// CodeMirror loads with the first formula, not with the grid.
const FormulaEditor = lazy(() => import("./formula-editor"));

/** What a formula of a table may name, and how what it names is typed. */
export type FormulaScope = {
  refs: Array<{ name: string; label: string }>;
  typeContext: FormulaTypeContext;
};

function asTypeColumn(column: CatalogColumn): FormulaTypeColumn {
  return {
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
  };
}

/**
 * What a formula written on `table` may name: its other fields, and
 * through its links the fields of the tables they reach. The field being
 * edited is left out: a formula does not read itself.
 */
export function formulaScope(
  table: CatalogTable,
  tables: readonly CatalogTable[],
  editing: string | undefined,
): FormulaScope {
  return {
    refs: table.columns
      .filter((column) => column.name !== editing)
      .map((column) => ({ name: column.name, label: column.label })),
    typeContext: {
      tableId: table.id,
      columns: table.columns.map(asTypeColumn),
      tables: tables.map((item) => ({
        id: item.id,
        columns: item.columns.map(asTypeColumn),
      })),
      engine: formulaEngine(table.external),
      excludeColumn: editing,
    },
  };
}

/** A formula: its editor, the fields it may name, and the functions' help. */
export function FormulaSettings({
  draft,
  set,
  table,
  editing,
  scope,
}: SettingsProps & {
  table: CatalogTable;
  /** The formula field being changed, with what it held. */
  editing: CatalogColumn | null;
  scope: FormulaScope;
}) {
  const { t } = useLingui();
  const editor = useRef<FormulaEditorHandle>(null);
  // Where the caret is, once the editor has loaded; at the end before.
  function insert(text: string, options?: { back?: number }) {
    if (editor.current) editor.current.insert(text, options);
    else set({ formula: draft.formula + text });
  }
  return (
    <div className="grid grid-cols-[1fr_16rem] gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t`Formula`}</span>
        <Suspense
          fallback={
            <div className="min-h-32 rounded-md border border-border" />
          }
        >
          <FormulaEditor
            handle={editor}
            value={draft.formula}
            onChange={(formula) => set({ formula })}
            refs={scope.refs}
            label={t`Formula`}
            describedBy="formula-help"
            engine={scope.typeContext.engine}
            typeContext={scope.typeContext}
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
                onClick={() => insert(`{${column.label}}`)}
              >
                <FieldIcon fieldType={column.fieldType} />
                {column.label}
              </button>
            ))}
        </div>
      </div>
      <FormulaHelpPanel onInsert={insert} />
    </div>
  );
}
