import type { FilterGroup, LinkSelection } from "@anygriddb/core";
import { Label, Select } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc";
import type { CatalogTable, Collaborator } from "../../lib/types";
import { FilterBuilder } from "../table/filter-builder";

const EMPTY: FilterGroup = { conjunction: "and", conditions: [] };

/**
 * Which rows a link field offers and accepts: all of the linked table's,
 * those of one of its shared views, or those a filter keeps. The server
 * applies it to the picker and refuses a link added outside it.
 */
export function LinkSelectionEditor({
  value,
  onChange,
  target,
  people,
}: {
  value: LinkSelection | undefined;
  onChange: (value: LinkSelection | undefined) => void;
  target: CatalogTable;
  people: ReadonlyMap<string, Collaborator>;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const views = useQuery(
    api.catalog.views.queryOptions({ tableId: target.id }),
  );
  // A personal view is its owner's: only shared views can limit a field.
  const shared = (views.data?.views ?? []).filter(
    (view) => !view.personal && view.viewType !== "form",
  );
  const mode = !value ? "all" : "view" in value ? "view" : "filter";
  const missing =
    value !== undefined &&
    "view" in value &&
    views.isSuccess &&
    !shared.some((view) => view.id === value.view);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="link-selection">{t`Rows offered`}</Label>
      <Select
        id="link-selection"
        value={mode}
        onChange={(event) => {
          const next = event.target.value;
          onChange(
            next === "view"
              ? shared[0]
                ? { view: shared[0].id }
                : undefined
              : next === "filter"
                ? { filter: EMPTY }
                : undefined,
          );
        }}
      >
        <option value="all">{t`Every row of ${{ table: target.name }}`}</option>
        <option value="view" disabled={shared.length === 0}>
          {t`The rows of a shared view`}
        </option>
        <option value="filter">{t`The rows that match a filter`}</option>
      </Select>
      {value && "view" in value ? (
        <Select
          aria-label={t`View`}
          value={value.view}
          onChange={(event) => onChange({ view: event.target.value })}
        >
          {missing ? (
            <option value={value.view}>{t`Unknown view`}</option>
          ) : null}
          {shared.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
            </option>
          ))}
        </Select>
      ) : null}
      {missing ? (
        <p role="alert" className="text-xs text-danger">
          {t`The chosen view no longer exists or is no longer shared: every row is offered. Pick another one.`}
        </p>
      ) : null}
      {value && "filter" in value ? (
        <div className="rounded-md border border-border p-2">
          <FilterBuilder
            group={value.filter}
            columns={target.columns}
            people={people}
            onChange={(filter) => onChange({ filter })}
          />
        </div>
      ) : null}
      {value ? (
        <p className="text-xs text-muted-foreground">
          {t`A row outside this selection cannot be linked; links already in place stay.`}
        </p>
      ) : null}
    </div>
  );
}
