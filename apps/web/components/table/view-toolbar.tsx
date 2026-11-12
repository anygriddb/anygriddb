import {
  MAX_VIEW_GROUPS,
  MAX_VIEW_SORTS,
  type FilterGroup,
} from "@anygriddb/core";
import { ColorRulesEditor } from "./color-rules-editor";
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
  Tooltip,
} from "@anygriddb/ui";
import {
  ArrowDownUp,
  AlertCircle,
  Check,
  ChevronDown,
  Download,
  EyeOff,
  Filter,
  Group,
  Loader2,
  MoreHorizontal,
  Palette,
  Plus,
  Redo2,
  Rows3,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { useLocale } from "../../lib/i18n";
import { useNarrowScreen } from "../../lib/narrow-screen";
import type { CatalogColumn, Collaborator, ViewConfig } from "../../lib/types";
import { FieldIcon } from "../fields/field-meta";
import {
  countConditions,
  DATE_MODE_LABELS,
  FilterBuilder,
  OPERATOR_LABELS,
} from "./filter-builder";
import {
  chipValueText,
  filterChips,
  type ChipWords,
  withoutChip,
} from "./filter-chips";
import { raw } from "../../lib/known-text";
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
  /** When the last change reached the database: the bar says so. */
  savedAt?: Date | null;
  saveStatus?: "idle" | "saving" | "saved" | "error";
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const { config, allColumns } = props;
  const [draft, setDraft] = useState<FilterGroup>(
    config.filter ?? { conjunction: "and", conditions: [] },
  );
  const [searchText, setSearchText] = useState(props.search);
  const [rulesOpen, setRulesOpen] = useState(false);
  const narrow = useNarrowScreen();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
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
  // Control-plane enrichment cannot sort or group on the client (ADR 0046).
  const orderable = allColumns.filter((column) => !column.controlPlane);
  const { conjunction: joined, chips } = filterChips(config.filter);
  const chipWords: ChipWords = {
    me: t`Me`,
    checked: t`checked`,
    unchecked: t`unchecked`,
    period: (mode) => t(DATE_MODE_LABELS[mode] ?? raw(mode)),
    person: (id) => props.people.get(id)?.displayName,
  };
  const columnLabel = (name: string) =>
    allColumns.find((column) => column.name === name)?.label ?? name;

  // The controls of the view, laid out in one line on a wide screen; on
  // a narrow one, the filter stays in the line and the others fold behind
  // one button.
  const fieldsControl = (
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
                {/* The primary field names the row: it always shows. */}
                <Checkbox
                  checked={column.isPrimary || !hidden.has(column.name)}
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
  );
  const filterControl = (
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
  );
  const sortControl = (
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
                {orderable.map((column) => (
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
        {sorts.length < MAX_VIEW_SORTS ? (
          <Button
            size="xs"
            variant="ghost"
            className="mt-2"
            onClick={() => {
              const column = orderable.find(
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
  );
  const groupControl = props.gridOnly ? (
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
                {orderable
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
                    groupBy: groups.filter((_, at) => at !== index),
                  })
                }
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {groups.length < MAX_VIEW_GROUPS ? (
          <Button
            size="xs"
            variant="ghost"
            className="mt-2"
            onClick={() => {
              const column = orderable.find(
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
      </PopoverContent>
    </Popover>
  ) : null;
  const heightControl = props.gridOnly ? (
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
  ) : null;
  const colorControl = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolButton
          active={
            config.color?.mode === "select" || config.color?.mode === "rules"
          }
        >
          <Palette className="h-3.5 w-3.5" aria-hidden />
          {t`Color`}
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => props.onPatch({ color: null })}>
          {t`None`}
        </DropdownMenuItem>
        {selectable.length > 0 ? (
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
        ) : null}
        <DropdownMenuSection title={t`By rules`}>
          <DropdownMenuItem
            onSelect={() => {
              if (config.color?.mode !== "rules") {
                props.onPatch({ color: { mode: "rules", rules: [] } });
              }
              setRulesOpen(true);
            }}
          >
            {t`Edit colour rules`}
            {config.color?.mode === "rules" ? " ✓" : ""}
          </DropdownMenuItem>
        </DropdownMenuSection>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const settingsActive =
    hidden.size > 0 ||
    sorts.length > 0 ||
    groups.length > 0 ||
    config.color?.mode === "select" ||
    config.color?.mode === "rules";

  return (
    <div className="border-b border-border bg-card">
      <div
        className={cn(
          "flex min-h-9 items-center gap-0.5 px-2 py-0.5",
          narrow ? "flex-nowrap" : "flex-wrap",
        )}
      >
        {props.onNewRow ? (
          <>
            {/* Same verb as the grid's last row; this one opens the new row. */}
            <ToolButton
              onClick={props.onNewRow}
              className="text-primary"
              aria-label={t`Add a row and open it`}
              title={t`Add a row and open it`}
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="max-md:hidden">{t`Add a row`}</span>
            </ToolButton>
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
          </>
        ) : null}
        {narrow ? (
          <>
            {filterControl}
            <Tooltip content={t`View settings`}>
              <ToolButton
                active={settingsActive}
                aria-label={t`View settings`}
                aria-expanded={settingsOpen}
                aria-controls={settingsId}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                <ChevronDown
                  className={cn("h-3.5 w-3.5", settingsOpen && "rotate-180")}
                  aria-hidden
                />
              </ToolButton>
            </Tooltip>
          </>
        ) : (
          <>
            {fieldsControl}
            {filterControl}
            {sortControl}
            {groupControl}
            {heightControl}
            {colorControl}
          </>
        )}
        <ColorRulesEditor
          open={rulesOpen}
          onOpenChange={setRulesOpen}
          columns={allColumns}
          people={props.people}
          rules={
            config.color?.mode === "rules" ? (config.color.rules ?? []) : []
          }
          onSave={(rules) =>
            props.onPatch({
              color: rules.length > 0 ? { mode: "rules", rules } : null,
            })
          }
        />

        <div className="ml-auto flex min-w-0 items-center gap-1">
          {props.saveStatus === "saving" ? (
            <span
              role="status"
              className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {t`Saving…`}
            </span>
          ) : props.saveStatus === "error" ? (
            <span
              role="status"
              className="mr-1 inline-flex items-center gap-1 text-xs text-danger"
            >
              <AlertCircle className="h-3 w-3" aria-hidden />
              {t`Save failed`}
            </span>
          ) : props.savedAt ? (
            // Routine edits are confirmed here, not by a toast.
            <span
              role="status"
              className="mr-1 inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              <Check className="h-3 w-3" aria-hidden />
              <span className="max-md:sr-only">
                {t`Saved at ${{
                  time: new Intl.DateTimeFormat(
                    locale === "fr" ? "fr-FR" : "en-GB",
                    { hour: "2-digit", minute: "2-digit" },
                  ).format(props.savedAt),
                }}`}
              </span>
            </span>
          ) : null}
          <ToolButton
            aria-label={t`Undo`}
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
          <div className="relative min-w-20 flex-1 md:flex-none">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 opacity-50"
              aria-hidden
            />
            <Input
              aria-label={t`Search this view`}
              placeholder={t`Search`}
              className="h-7 w-full pl-7 text-xs md:w-44"
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
      {narrow && settingsOpen ? (
        <div
          id={settingsId}
          className="flex flex-wrap items-center gap-0.5 border-t border-border px-2 py-0.5"
        >
          {fieldsControl}
          {sortControl}
          {groupControl}
          {heightControl}
          {colorControl}
        </div>
      ) : null}
      {chips.length > 0 && !config.filtersDisabled ? (
        <div
          className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5"
          role="group"
          aria-label={t`Active filters`}
        >
          {chips.map((chip, position) => (
            <span key={chip.index} className="inline-flex items-center gap-1.5">
              {position > 0 ? (
                <span className="text-[11px] text-muted-foreground">
                  {joined === "or" ? t`or` : t`and`}
                </span>
              ) : null}
              <span className="inline-flex max-w-full items-center gap-0.5 rounded-sm border border-rule bg-head text-[11px] text-foreground">
                <button
                  type="button"
                  className="truncate px-1.5 py-0.5 hover:bg-muted"
                  onClick={() => props.onFilterOpen(true)}
                >
                  {chip.kind === "group"
                    ? plural(chip.count, {
                        one: "# grouped condition",
                        other: "# grouped conditions",
                      })
                    : [
                        columnLabel(chip.condition.column),
                        t(OPERATOR_LABELS[chip.condition.op]),
                        chipValueText(chip.condition.value, chipWords),
                      ]
                        .filter(Boolean)
                        .join(" ")}
                </button>
                <button
                  type="button"
                  className="px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t`Remove filter`}
                  onClick={() =>
                    props.onPatch({
                      filter: withoutChip(config.filter, chip.index),
                    })
                  }
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            </span>
          ))}
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => props.onPatch({ filter: null })}
          >
            {t`Clear filters`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
