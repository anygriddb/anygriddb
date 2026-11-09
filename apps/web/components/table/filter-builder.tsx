import {
  DATE_MODES,
  filterOperatorsFor,
  WITHIN_MODES,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
  type FilterValue,
} from "@anygriddb/core";
import { Button, Checkbox, Input, Select } from "@anygriddb/ui";
import { Plus, Trash2 } from "lucide-react";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { optionsOf } from "../fields/cell-value";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { raw } from "../../lib/known-text";

export const OPERATOR_LABELS: Record<FilterOperator, MessageDescriptor> = {
  is: msg`is`,
  is_not: msg`is not`,
  contains: msg`contains`,
  not_contains: msg`does not contain`,
  starts_with: msg`starts with`,
  ends_with: msg`ends with`,
  is_empty: msg`is empty`,
  is_not_empty: msg`is not empty`,
  gt: msg`>`,
  gte: msg`≥`,
  lt: msg`<`,
  lte: msg`≤`,
  is_any_of: msg`is any of`,
  is_none_of: msg`is none of`,
  has_any_of: msg`has any of`,
  has_all_of: msg`has all of`,
  has_none_of: msg`has none of`,
  is_exactly: msg`is exactly`,
  is_before: msg`is before`,
  is_after: msg`is after`,
  is_on_or_before: msg`is on or before`,
  is_on_or_after: msg`is on or after`,
  is_within: msg`is within`,
  is_between: msg`is between`,
};

export const DATE_MODE_LABELS: Record<string, MessageDescriptor> = {
  today: msg`today`,
  yesterday: msg`yesterday`,
  tomorrow: msg`tomorrow`,
  days_ago: msg`N days ago`,
  days_from_now: msg`in N days`,
  this_week: msg`this week`,
  last_week: msg`last week`,
  next_week: msg`next week`,
  this_month: msg`this month`,
  last_month: msg`last month`,
  next_month: msg`next month`,
  this_year: msg`this year`,
  last_year: msg`last year`,
  next_year: msg`next year`,
  exact: msg`an exact date`,
  past_week: msg`the past 7 days`,
  past_month: msg`the past month`,
  past_year: msg`the past year`,
  past_days: msg`the past N days`,
  next_days: msg`the next N days`,
};

const SET_OPS = new Set<FilterOperator>([
  "is_any_of",
  "is_none_of",
  "has_any_of",
  "has_all_of",
  "has_none_of",
  "is_exactly",
]);

export function operatorsFor(column: CatalogColumn): FilterOperator[] {
  const ops = filterOperatorsFor(column.kind);
  if (column.kind === "links") return ops.filter((op) => !SET_OPS.has(op));
  if (column.kind === "text" && column.fieldType !== "single_select") {
    return ops.filter((op) => op !== "is_any_of" && op !== "is_none_of");
  }
  return [...ops];
}

function defaultValue(
  column: CatalogColumn,
  op: FilterOperator,
): FilterValue | undefined {
  if (op === "is_empty" || op === "is_not_empty") return undefined;
  if (op === "is_between") return ["", ""];
  if (column.kind === "boolean") return true;
  if (column.kind === "date" || column.kind === "datetime")
    return { mode: op === "is_within" ? "past_week" : "today" };
  if (SET_OPS.has(op)) return [];
  return "";
}

export function newCondition(column: CatalogColumn): FilterCondition {
  const op = operatorsFor(column)[0] ?? "is";
  return { column: column.name, op, value: defaultValue(column, op) };
}

function ValueInput({
  column,
  condition,
  people,
  onChange,
}: {
  column: CatalogColumn;
  condition: FilterCondition;
  people: ReadonlyMap<string, Collaborator>;
  onChange: (value: FilterValue | undefined) => void;
}) {
  const { t } = useLingui();
  const { op, value } = condition;
  if (op === "is_empty" || op === "is_not_empty") return null;
  if (column.kind === "boolean") {
    return (
      <label className="flex items-center gap-1 text-sm">
        <Checkbox
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {value === true ? t`checked` : t`unchecked`}
      </label>
    );
  }
  if (op === "is_between") {
    const ends = Array.isArray(value) && value.length === 2 ? value : ["", ""];
    const dates = column.kind === "date" || column.kind === "datetime";
    const end = (index: 0 | 1, label: string) => (
      <Input
        type={dates ? "date" : "text"}
        inputMode={dates ? undefined : "decimal"}
        aria-label={label}
        className={dates ? "h-8 w-40" : "h-8 w-28"}
        value={ends[index] ?? ""}
        onChange={(event) => {
          const next = [...ends];
          next[index] = event.target.value;
          onChange(next);
        }}
      />
    );
    return (
      <div className="flex items-center gap-1 text-sm">
        {end(0, t`From`)}
        <span className="text-muted-foreground">{t`and`}</span>
        {end(1, t`To`)}
      </div>
    );
  }
  if (column.kind === "date" || column.kind === "datetime") {
    const spec =
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : { mode: "today" as const };
    const modes = op === "is_within" ? WITHIN_MODES : DATE_MODES;
    return (
      <div className="flex gap-1">
        <Select
          aria-label={t`Period`}
          className="h-8 w-44"
          value={spec.mode}
          onChange={(event) =>
            onChange({ ...spec, mode: event.target.value as never })
          }
        >
          {modes.map((mode) => (
            <option key={mode} value={mode}>
              {t(DATE_MODE_LABELS[mode] ?? raw(mode))}
            </option>
          ))}
        </Select>
        {spec.mode === "exact" ? (
          <Input
            type="date"
            aria-label={t`Date`}
            className="h-8 w-40"
            value={spec.date ?? ""}
            onChange={(event) =>
              onChange({ ...spec, date: event.target.value })
            }
          />
        ) : null}
        {spec.mode.endsWith("_days") ||
        spec.mode === "days_ago" ||
        spec.mode === "days_from_now" ? (
          <Input
            type="number"
            min={0}
            aria-label={t`Days`}
            className="h-8 w-20"
            value={spec.days ?? 0}
            onChange={(event) =>
              onChange({
                ...spec,
                days: Math.max(0, Number(event.target.value) || 0),
              })
            }
          />
        ) : null}
      </div>
    );
  }
  if (
    SET_OPS.has(op) ||
    ((op === "is" || op === "is_not") && column.kind === "user")
  ) {
    const items = Array.isArray(value)
      ? value
      : typeof value === "string" && value
        ? [value]
        : [];
    const choices =
      column.kind === "users" || column.kind === "user"
        ? [
            { value: "me", label: t`Me` },
            ...[...people.values()].map((person) => ({
              value: person.id,
              label: person.displayName,
            })),
          ]
        : optionsOf(column).map((option) => ({
            value: option.name,
            label: option.name,
          }));
    return (
      <div className="flex max-h-28 min-w-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className="flex items-center gap-1.5 text-xs"
          >
            <Checkbox
              checked={items.includes(choice.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...items, choice.value]
                    : items.filter((item) => item !== choice.value),
                )
              }
            />
            {choice.label}
          </label>
        ))}
      </div>
    );
  }
  if (
    column.fieldType === "single_select" &&
    (op === "is" || op === "is_not")
  ) {
    return (
      <Select
        aria-label={t`Value`}
        className="h-8 w-40"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">—</option>
        {optionsOf(column).map((option) => (
          <option key={option.name} value={option.name}>
            {option.name}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      aria-label={t`Value`}
      className="h-8 w-40"
      inputMode={column.kind === "number" ? "decimal" : undefined}
      value={
        typeof value === "string" || typeof value === "number"
          ? String(value)
          : ""
      }
      // A number stays the text that was typed: the server reads it as an
      // exact decimal, and "1." must survive on the way to "1.5".
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** Recursive and/or editor for a view filter, three levels deep. */
export function FilterBuilder({
  group,
  columns,
  people,
  depth = 1,
  onChange,
}: {
  group: FilterGroup;
  columns: readonly CatalogColumn[];
  people: ReadonlyMap<string, Collaborator>;
  depth?: number;
  onChange: (group: FilterGroup) => void;
}) {
  const { t } = useLingui();
  const first = columns[0];
  const update = (
    index: number,
    node: FilterCondition | FilterGroup | null,
  ) => {
    const conditions = [...group.conditions];
    if (node === null) conditions.splice(index, 1);
    else conditions[index] = node;
    onChange({ ...group, conditions });
  };
  return (
    <div
      className={
        depth > 1
          ? "flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2"
          : "flex flex-col gap-2"
      }
    >
      {group.conditions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t`No conditions`}</p>
      ) : null}
      {group.conditions.map((node, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="w-16 pt-1.5 text-xs text-muted-foreground">
            {index === 0 ? (
              t`Where`
            ) : index === 1 ? (
              <Select
                aria-label={t`Conjunction`}
                className="h-7 px-1 text-xs"
                value={group.conjunction}
                onChange={(event) =>
                  onChange({
                    ...group,
                    conjunction: event.target.value === "or" ? "or" : "and",
                  })
                }
              >
                <option value="and">{t`and`}</option>
                <option value="or">{t`or`}</option>
              </Select>
            ) : group.conjunction === "and" ? (
              t`and`
            ) : (
              t`or`
            )}
          </div>
          {"conjunction" in node ? (
            <div className="flex-1">
              <FilterBuilder
                group={node}
                columns={columns}
                people={people}
                depth={depth + 1}
                onChange={(next) => update(index, next)}
              />
            </div>
          ) : (
            (() => {
              const column =
                columns.find((item) => item.name === node.column) ?? first;
              if (!column) return null;
              return (
                <div className="flex flex-1 flex-wrap items-start gap-1">
                  <Select
                    aria-label={t`Field`}
                    className="h-8 w-40"
                    value={node.column}
                    onChange={(event) => {
                      const next = columns.find(
                        (item) => item.name === event.target.value,
                      );
                      if (next) update(index, newCondition(next));
                    }}
                  >
                    {columns.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.label}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={t`Operator`}
                    className="h-8 w-40"
                    value={node.op}
                    onChange={(event) => {
                      const op = event.target.value as FilterOperator;
                      update(index, {
                        column: node.column,
                        op,
                        value: defaultValue(column, op),
                      });
                    }}
                  >
                    {operatorsFor(column).map((op) => (
                      <option key={op} value={op}>
                        {t(OPERATOR_LABELS[op])}
                      </option>
                    ))}
                  </Select>
                  <ValueInput
                    column={column}
                    condition={node}
                    people={people}
                    onChange={(value) => update(index, { ...node, value })}
                  />
                </div>
              );
            })()
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t`Remove condition`}
            onClick={() => update(index, null)}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={!first}
          onClick={() =>
            first &&
            onChange({
              ...group,
              conditions: [...group.conditions, newCondition(first)],
            })
          }
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t`Add a condition`}
        </Button>
        {depth < 3 ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!first}
            onClick={() =>
              first &&
              onChange({
                ...group,
                conditions: [
                  ...group.conditions,
                  { conjunction: "and", conditions: [newCondition(first)] },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t`Add a group`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function countConditions(group: FilterGroup | undefined): number {
  if (!group) return 0;
  return group.conditions.reduce(
    (total, node) =>
      total + ("conjunction" in node ? countConditions(node) : 1),
    0,
  );
}
