import type { FilterGroup } from "@anygriddb/core";
import {
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSection,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
} from "@anygriddb/ui";
import {
  ArrowDownUp,
  Download,
  EyeOff,
  Filter,
  Group,
  MoreHorizontal,
  Palette,
  Plus,
  Redo2,
  Rows3,
  Search,
  Trash2,
  Undo2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import type { CatalogColumn, Collaborator, ViewConfig } from "../../lib/types";
import { FieldIcon } from "../fields/field-meta";
import { countConditions, FilterBuilder } from "./filter-builder";
import { useLingui } from "@lingui/react/macro";
import { msg, plural } from "@lingui/core/macro";

export type ViewPatch = Partial<{
  [K in keyof ViewConfig]: ViewConfig[K] | null;
}>;

const ROW_HEIGHT_LABELS = {
  short: msg`Short`,
  medium: msg`Average`,
  tall: msg`Tall`,
  extra: msg`Extra tall`,
};

function ToolButton({
  active,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { active?: boolean }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      className={cn(active && "bg-accent text-accent-foreground")}
      {...props}
    >
      {children}
    </Button>
  );
}

export function ViewToolbar(props: {
  config: ViewConfig;
  columns: readonly CatalogColumn[];
  allColumns: readonly CatalogColumn[];
  people: ReadonlyMap<string, Collaborator>;
  search: string;
  onSearch: (value: string) => void;
  onPatch: (patch: ViewPatch) => void;
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExport: (format: "csv" | "json" | "xlsx") => void;
  onImport: () => void;
  onTrash: () => void;
  /** Shown to those who manage the table. */
  onAutomations?: () => void;
  /** Shown to those who may add rows. */
  onNewRow?: () => void;
  gridOnly: boolean;
  filterOpen: boolean;
  onFilterOpen: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const { config, allColumns } = props;
  const [draft, setDraft] = useState<FilterGroup>(
    config.filter ?? { conjunction: "and", conditions: [] },
  );
  const [searchText, setSearchText] = useState(props.search);
  // The saved filter changed (another tab, an undo): the draft follows it.
  const [draftOf, setDraftOf] = useState(config.filter);
  if (draftOf !== config.filter) {
    setDraftOf(config.filter);
    setDraft(config.filter ?? { conjunction: "and", conditions: [] });
  }
  const search = useEffectEvent((text: string) => props.onSearch(text));
  useEffect(() => {
    const timer = setTimeout(() => search(searchText.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchText]);

  const hidden = new Set(config.hiddenFields ?? []);
  const sorts = config.sort ?? [];
  const groups = config.groupBy ?? [];
  const filterCount = countConditions(config.filter);
  const selectable = allColumns.filter(
    (column) =>
      column.fieldType === "single_select" ||
      column.fieldType === "multi_select",
  );

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border bg-card px-3 py-1.5">
      {props.onNewRow ? (
        <ToolButton onClick={props.onNewRow}>
          <Plus className="h-4 w-4" aria-hidden />
          {t`New row`}
        </ToolButton>
      ) : null}
      <Popover>
        <PopoverTrigger asChild>
          <ToolButton active={hidden.size > 0}>
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            {hidden.size > 0
              ? plural(hidden.size, {
                  one: `# hidden field`,
                  other: `# hidden fields`,
                })
              : t`Fields`}
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <ul className="flex flex-col gap-0.5">
            {allColumns.map((column) => (
              <li key={column.name}>
                <label
                  className={cn(
                    "flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted",
                    column.isPrimary && "opacity-70",
                  )}
                >
                  <Checkbox
                    checked={!hidden.has(column.name)}
                    disabled={column.isPrimary}
                    onChange={(event) => {
                      const next = new Set(hidden);
                      if (event.target.checked) next.delete(column.name);
                      else next.add(column.name);
                      props.onPatch({ hiddenFields: [...next] });
                    }}
                  />
                  <FieldIcon fieldType={column.fieldType} />
                  <span className="truncate">{column.label}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onPatch({ hiddenFields: null })}
            >
              {t`Show all`}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.onPatch({
                  hiddenFields: allColumns
                    .filter((column) => !column.isPrimary)
                    .map((column) => column.name),
                })
              }
            >
              {t`Hide all`}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={props.filterOpen} onOpenChange={props.onFilterOpen}>
        <PopoverTrigger asChild>
          <ToolButton active={filterCount > 0 && !config.filtersDisabled}>
            <Filter className="h-3.5 w-3.5" aria-hidden />
            {filterCount > 0
              ? plural(filterCount, { one: "# filter", other: "# filters" })
              : t`Filter`}
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent className="w-[40rem] max-w-[95vw]">
          <FilterBuilder
            group={draft}
            columns={allColumns}
            people={props.people}
            onChange={setDraft}
          />
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={config.filtersDisabled === true}
                onChange={(event) =>
                  props.onPatch({
                    filtersDisabled: event.target.checked ? true : null,
                  })
                }
              />
              {t`Temporarily disable filters`}
            </label>
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => props.onPatch({ filter: null })}
              >
                {t`Clear`}
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  props.onPatch({
                    filter: draft.conditions.length > 0 ? draft : null,
                  });
                  props.onFilterOpen(false);
                }}
              >
                {t`Apply`}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <ToolButton active={sorts.length > 0}>
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
            {sorts.length > 0
              ? t`Sorted by ${{ count: sorts.length }} fields`
              : t`Sort`}
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent className="w-96">
          <ul className="flex flex-col gap-1.5">
            {sorts.map((sort, index) => (
              <li key={index} className="flex items-center gap-1.5">
                <Select
                  aria-label={t`Field`}
                  className="h-8"
                  value={sort.column}
                  onChange={(event) =>
                    props.onPatch({
                      sort: sorts.map((item, at) =>
                        at === index
                          ? { ...item, column: event.target.value }
                          : item,
                      ),
                    })
                  }
                >
                  {allColumns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.label}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={t`Order`}
                  className="h-8 w-28"
                  value={sort.direction}
                  onChange={(event) =>
                    props.onPatch({
                      sort: sorts.map((item, at) =>
                        at === index
                          ? {
                              ...item,
                              direction:
                                event.target.value === "desc" ? "desc" : "asc",
                            }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="asc">A → Z</option>
                  <option value="desc">Z → A</option>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t`Remove`}
                  onClick={() =>
                    props.onPatch({
                      sort: sorts.filter((_, at) => at !== index),
                    })
                  }
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          {sorts.length < 5 ? (
            <Button
              size="xs"
              variant="ghost"
              className="mt-2"
              onClick={() => {
                const column = allColumns.find(
                  (item) => !sorts.some((sort) => sort.column === item.name),
                );
                if (column)
                  props.onPatch({
                    sort: [...sorts, { column: column.name, direction: "asc" }],
                  });
              }}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t`Add a sort`}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>

      {props.gridOnly ? (
        <Popover>
          <PopoverTrigger asChild>
            <ToolButton active={groups.length > 0}>
              <Group className="h-3.5 w-3.5" aria-hidden />
              {groups.length > 0
                ? t`Grouped by ${{ count: groups.length }} fields`
                : t`Group`}
            </ToolButton>
          </PopoverTrigger>
          <PopoverContent className="w-96">
            <ul className="flex flex-col gap-1.5">
              {groups.map((group, index) => (
                <li key={index} className="flex items-center gap-1.5">
                  <Select
                    aria-label={t`Field`}
                    className="h-8"
                    value={group.column}
                    onChange={(event) =>
                      props.onPatch({
                        groupBy: groups.map((item, at) =>
                          at === index
                            ? { ...item, column: event.target.value }
                            : item,
                        ),
                      })
                    }
                  >
                    {allColumns
                      .filter((column) => column.fieldType !== "attachment")
                      .map((column) => (
                        <option key={column.name} value={column.name}>
                          {column.label}
                        </option>
                      ))}
                  </Select>
                  <Select
                    aria-label={t`Order`}
                    className="h-8 w-28"
                    value={group.direction}
                    onChange={(event) =>
                      props.onPatch({
                        groupBy: groups.map((item, at) =>
                          at === index
                            ? {
                                ...item,
                                direction:
                                  event.target.value === "desc"
                                    ? "desc"
                                    : "asc",
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    <option value="asc">A → Z</option>
                    <option value="desc">Z → A</option>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t`Remove`}
                    onClick={() =>
                      props.onPatch({
                        groupBy: groups.filter((_, at) => at !== index),
                      })
                    }
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            {groups.length < 3 ? (
              <Button
                size="xs"
                variant="ghost"
                className="mt-2"
                onClick={() => {
                  const column = allColumns.find(
                    (item) =>
                      !groups.some((group) => group.column === item.name) &&
                      item.fieldType !== "attachment",
                  );
                  if (column)
                    props.onPatch({
                      groupBy: [
                        ...groups,
                        { column: column.name, direction: "asc" },
                      ],
                    });
                }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t`Add a level`}
              </Button>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              {t`Grouping shows the first 1000 rows.`}
            </p>
          </PopoverContent>
        </Popover>
      ) : null}

      {props.gridOnly ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton>
              <Rows3 className="h-3.5 w-3.5" aria-hidden />
              {t`Row height`}
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {(["short", "medium", "tall", "extra"] as const).map((height) => (
              <DropdownMenuItem
                key={height}
                onSelect={() =>
                  props.onPatch({
                    rowHeight: height === "short" ? null : height,
                  })
                }
              >
                {t(ROW_HEIGHT_LABELS[height])}
                {(config.rowHeight ?? "short") === height ? " ✓" : ""}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {props.gridOnly && selectable.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton active={config.color?.mode === "select"}>
              <Palette className="h-3.5 w-3.5" aria-hidden />
              {t`Color`}
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => props.onPatch({ color: null })}>
              {t`None`}
            </DropdownMenuItem>
            <DropdownMenuSection title={t`By field`}>
              {selectable.map((column) => (
                <DropdownMenuItem
                  key={column.name}
                  textValue={column.label}
                  onSelect={() =>
                    props.onPatch({
                      color: { mode: "select", column: column.name },
                    })
                  }
                >
                  {column.label}
                  {config.color?.column === column.name ? " ✓" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSection>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        <ToolButton
          aria-label={t`Cancel`}
          disabled={!props.canUndo}
          onClick={props.onUndo}
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
        </ToolButton>
        <ToolButton
          aria-label={t`Redo`}
          disabled={!props.canRedo}
          onClick={props.onRedo}
        >
          <Redo2 className="h-3.5 w-3.5" aria-hidden />
        </ToolButton>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 opacity-50"
            aria-hidden
          />
          <Input
            aria-label={t`Search this view`}
            placeholder={t`Search`}
            className="h-7 w-44 pl-7 text-xs"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolButton aria-label={t`More actions`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </ToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => props.onExport("csv")}>
              <Download className="h-4 w-4" aria-hidden />
              {t`Export view as CSV`}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onExport("xlsx")}>
              <Download className="h-4 w-4" aria-hidden />
              {t`Export view to Excel`}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => props.onExport("json")}>
              <Download className="h-4 w-4" aria-hidden />
              {t`Export view to JSON`}
            </DropdownMenuItem>
            {props.canEdit ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onImport}>
                  <Upload className="h-4 w-4" aria-hidden />
                  {t`Import a file`}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {props.onAutomations ? (
                  <DropdownMenuItem onSelect={props.onAutomations}>
                    <Zap className="h-4 w-4" aria-hidden />
                    {t`Automations`}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={props.onTrash}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t`Row trash`}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
