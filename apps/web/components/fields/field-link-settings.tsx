import {
  type FilterGroup,
  limitOf,
  ROLLUP_FNS,
  rollupFitsTarget,
} from "@anygriddb/core";
import { Checkbox, Label, Select } from "@anygriddb/ui";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { raw } from "../../lib/known-text";
import { distinctLimits, formulaEngine, useLimitText } from "../../lib/limits";
import type { CatalogTable, Collaborator } from "../../lib/types";
import { FilterBuilder } from "../table/filter-builder";
import type { SettingsProps } from "./field-settings";
import { LimitNotice } from "./limit-notice";

const NO_PEOPLE = new Map<string, Collaborator>();

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

/** A new link: the table it reaches, one row or several, and back. */
export function NewLinkSettings({
  draft,
  set,
  table,
  tables,
}: SettingsProps & {
  table: CatalogTable;
  tables: readonly CatalogTable[];
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="link-table">{t`Linked table`}</Label>
        <Select
          id="link-table"
          value={draft.linkTable}
          onChange={(event) => set({ linkTable: event.target.value })}
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
          checked={draft.linkMultiple}
          onChange={(event) => set({ linkMultiple: event.target.checked })}
        />
        {t`Allow several linked rows`}
      </label>
      {draft.linkTable !== table.id ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.twoWay}
            onChange={(event) => set({ twoWay: event.target.checked })}
          />
          {t`Also create the inverse field in the other table`}
        </label>
      ) : null}
    </div>
  );
}

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

/**
 * A lookup or a rollup: the link it goes through, the field of the linked
 * rows it reads, how a rollup adds them up, and the condition the linked
 * rows must match. Once made, only its condition changes.
 */
export function LookupSettings({
  draft,
  set,
  table,
  tables,
  isNew,
}: SettingsProps & {
  table: CatalogTable;
  tables: readonly CatalogTable[];
  isNew: boolean;
}) {
  const { t } = useLingui();
  const limitText = useLimitText();
  const rollup = draft.fieldType === "rollup";
  const linkColumns = table.columns.filter((column) => column.relation);
  const through = linkColumns.find((column) => column.name === draft.relation);
  const linked = tables.find(
    (item) => item.id === through?.relation?.targetTableId,
  );
  const read = linked?.columns.find(
    (column) => column.name === draft.targetColumn,
  );
  // What the client's engine computes differently: the field it reads,
  // and the rollup's own computation.
  const engine = formulaEngine(table.external);
  const limits = distinctLimits([
    ...(read?.limits ?? []),
    ...(rollup && engine
      ? [limitOf(engine, draft.rollupFn)].filter((limit) => limit !== null)
      : []),
  ]).map(limitText);
  const condition = linked ? (
    <LinkedCondition
      value={draft.linkedFilter}
      onChange={(linkedFilter) => set({ linkedFilter })}
      target={linked}
    />
  ) : null;
  if (!isNew) return condition;
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="lookup-relation">{t`Through link`}</Label>
        <Select
          id="lookup-relation"
          value={draft.relation}
          onChange={(event) => set({ relation: event.target.value })}
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
          value={draft.targetColumn}
          onChange={(event) => set({ targetColumn: event.target.value })}
        >
          <option value="">—</option>
          {(linked?.columns ?? [])
            .filter((column) => !column.relation)
            .map((column) => (
              <option key={column.name} value={column.name}>
                {column.label}
              </option>
            ))}
        </Select>
      </div>
      {rollup ? (
        <div className="col-span-2 flex flex-col gap-1">
          <Label htmlFor="rollup-fn">{t`Aggregation`}</Label>
          <Select
            id="rollup-fn"
            value={draft.rollupFn}
            onChange={(event) => set({ rollupFn: event.target.value })}
          >
            {ROLLUP_FNS.filter(
              // Only what computes on the chosen field's type.
              (fn) =>
                fn === draft.rollupFn ||
                !read ||
                rollupFitsTarget(fn, read.fieldType),
            ).map((fn) => (
              <option key={fn} value={fn}>
                {t(ROLLUP_LABELS[fn] ?? raw(fn))}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {limits.length > 0 ? (
        <div className="col-span-2">
          <LimitNotice texts={limits} />
        </div>
      ) : null}
      {condition}
      {linkColumns.length === 0 ? (
        <p className="col-span-2 text-sm text-muted-foreground">
          {t`Add a link to another table first.`}
        </p>
      ) : null}
    </div>
  );
}
