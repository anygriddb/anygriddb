import {
  MAX_AUTOMATION_ACTIONS,
  MAX_LOOP_ROWS,
  MAX_NESTED_ACTIONS,
  TEMPLATE_KEYS,
  WRITABLE_TYPES,
  type AutomationAction,
  type AutomationStep,
  type AutomationTrigger,
  type FilterGroup,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, History, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import type { CatalogColumn } from "../../lib/types";
import { FilterBuilder } from "./filter-builder";
import { useTable } from "./table-context";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

type Automation = RouterOutputs["automations"]["list"]["automations"][number];
type TriggerType = AutomationTrigger["type"];
type ActionType = AutomationAction["type"];
type StepType = AutomationStep["type"];

const TRIGGERS: TriggerType[] = [
  "row_created",
  "row_updated",
  "row_deleted",
  "enters_filter",
  "form_submitted",
  "schedule",
  "button",
  "webhook",
];
/** What a branch or a loop holds: actions that hold no other. */
const STEPS: StepType[] = [
  "update_record",
  "delete_record",
  "create_record",
  "send_email",
  "call_webhook",
  "notify",
];
const ACTIONS: ActionType[] = [...STEPS, "branch", "for_each"];
/** Actions about the trigger's row, which some triggers have not. */
const ROW_ACTIONS = new Set<ActionType>([
  "update_record",
  "delete_record",
  "branch",
]);
const ROWLESS = new Set<TriggerType>(["schedule", "webhook", "row_deleted"]);
const EMPTY_FILTER: FilterGroup = { conjunction: "and", conditions: [] };

function useLabels() {
  const { t } = useLingui();
  const trigger = (type: TriggerType) =>
    ({
      row_created: t`A row is created`,
      row_updated: t`A row is updated`,
      enters_filter: t`A row meets a condition`,
      form_submitted: t`A form is submitted`,
      schedule: t`On a schedule`,
      button: t`A button is clicked`,
      row_deleted: t`A row is deleted`,
      webhook: t`A call to its address (incoming webhook)`,
    })[type];
  const action = (type: ActionType) =>
    ({
      update_record: t`Update the row`,
      delete_record: t`Delete row`,
      create_record: t`Create a row`,
      send_email: t`Send an email`,
      call_webhook: t`Call a URL`,
      notify: t`Notify collaborators`,
      branch: t`If… then… otherwise…`,
      for_each: t`For each row of…`,
    })[type];
  return { trigger, action };
}

function writable(columns: readonly CatalogColumn[]) {
  return columns.filter((column) =>
    (WRITABLE_TYPES as readonly string[]).includes(column.fieldType),
  );
}

function defaultTrigger(
  type: TriggerType,
  columns: readonly CatalogColumn[],
): AutomationTrigger {
  switch (type) {
    case "row_created":
      return { type };
    case "row_updated":
      return { type, columns: [] };
    case "enters_filter":
      return { type, filter: { conjunction: "and", conditions: [] } };
    case "form_submitted":
      return { type };
    case "schedule":
      return {
        type,
        every: "day",
        at: "09:00",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    case "button":
      return {
        type,
        column:
          columns.find((column) => column.fieldType === "button")?.name ?? "",
      };
    case "row_deleted":
    case "webhook":
      return { type };
  }
}

function defaultAction(type: ActionType, tableId: string): AutomationAction {
  switch (type) {
    case "branch":
      return {
        type,
        when: EMPTY_FILTER,
        then: [defaultStep("update_record", tableId)],
        otherwise: [],
      };
    case "for_each":
      return {
        type,
        tableId,
        limit: MAX_LOOP_ROWS,
        actions: [defaultStep("update_record", tableId)],
      };
    default:
      return defaultStep(type, tableId);
  }
}

function defaultStep(type: StepType, tableId: string): AutomationStep {
  switch (type) {
    case "delete_record":
      return { type };
    case "update_record":
      return { type, values: {} };
    case "create_record":
      return { type, tableId, values: {} };
    case "send_email":
      return { type, to: "", subject: "", body: "" };
    case "call_webhook":
      return { type, url: "https://" };
    case "notify":
      return { type, users: [], message: "" };
  }
}

/** Column → template rows, used by the update and create actions. */
function ValuesEditor(props: {
  columns: readonly CatalogColumn[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const { t } = useLingui();
  const unused = props.columns.filter(
    (column) => !(column.name in props.values),
  );
  return (
    <div className="flex flex-col gap-1">
      {Object.entries(props.values).map(([name, template]) => (
        <div key={name} className="flex items-center gap-1">
          <span className="w-36 shrink-0 truncate text-xs">
            {props.columns.find((column) => column.name === name)?.label ??
              name}
          </span>
          <Input
            aria-label={t`Value`}
            className="h-8 text-xs"
            value={template}
            onChange={(event) =>
              props.onChange({ ...props.values, [name]: event.target.value })
            }
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={t`Remove`}
            onClick={() => {
              const next = { ...props.values };
              Reflect.deleteProperty(next, name);
              props.onChange(next);
            }}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      {unused.length > 0 ? (
        <Select
          aria-label={t`Field to fill`}
          className="h-8 w-56 text-xs"
          value=""
          onChange={(event) => {
            if (event.target.value)
              props.onChange({ ...props.values, [event.target.value]: "" });
          }}
        >
          <option value="">{t`+ Field to fill`}</option>
          {unused.map((column) => (
            <option key={column.name} value={column.name}>
              {column.label}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

/** A list of actions inside a branch or a loop, about `columns`' rows. */
function StepsEditor(props: {
  steps: AutomationStep[];
  columns: readonly CatalogColumn[];
  tableId: string;
  onChange: (steps: AutomationStep[]) => void;
}) {
  const { t } = useLingui();
  const labels = useLabels();
  return (
    <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
      {props.steps.map((step, index) => (
        <div key={index} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Select
              aria-label={t`Action`}
              className="h-8 w-56 text-xs"
              value={step.type}
              onChange={(event) =>
                props.onChange(
                  props.steps.map((item, at) =>
                    at === index
                      ? defaultStep(
                          event.target.value as StepType,
                          props.tableId,
                        )
                      : item,
                  ),
                )
              }
            >
              {STEPS.map((type) => (
                <option key={type} value={type}>
                  {labels.action(type)}
                </option>
              ))}
            </Select>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t`Remove action`}
              onClick={() =>
                props.onChange(props.steps.filter((_, at) => at !== index))
              }
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
          <ActionEditor
            action={step}
            columns={props.columns}
            onChange={(next) =>
              props.onChange(
                props.steps.map((item, at) =>
                  at === index ? (next as AutomationStep) : item,
                ),
              )
            }
          />
        </div>
      ))}
      {props.steps.length < MAX_NESTED_ACTIONS ? (
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          onClick={() =>
            props.onChange([
              ...props.steps,
              defaultStep("update_record", props.tableId),
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t`Add an action`}
        </Button>
      ) : null}
    </div>
  );
}

function ActionEditor(props: {
  action: AutomationAction;
  /** The fields of the rows the action is about: a loop's, or the table's. */
  columns?: readonly CatalogColumn[];
  onChange: (action: AutomationAction) => void;
}) {
  const { t } = useLingui();
  const table = useTable();
  const { action } = props;
  const columns = props.columns ?? table.columns;
  switch (action.type) {
    case "update_record":
      return (
        <ValuesEditor
          columns={writable(columns)}
          values={action.values}
          onChange={(values) => props.onChange({ ...action, values })}
        />
      );
    case "delete_record":
      return (
        <p className="text-xs text-muted-foreground">
          {t`The row can still be restored from the deleted rows; the history keeps the automation's name.`}
        </p>
      );
    case "branch":
      return (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">{t`If the row matches:`}</span>
          <FilterBuilder
            group={action.when}
            columns={table.columns}
            people={table.people}
            onChange={(when: FilterGroup) =>
              props.onChange({ ...action, when })
            }
          />
          <span className="text-xs text-muted-foreground">{t`Then:`}</span>
          <StepsEditor
            steps={action.then}
            columns={table.columns}
            tableId={table.table.id}
            onChange={(then) => props.onChange({ ...action, then })}
          />
          <span className="text-xs text-muted-foreground">{t`Otherwise:`}</span>
          <StepsEditor
            steps={action.otherwise ?? []}
            columns={table.columns}
            tableId={table.table.id}
            onChange={(otherwise) => props.onChange({ ...action, otherwise })}
          />
        </div>
      );
    case "for_each": {
      const target = table.tables.find((item) => item.id === action.tableId);
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Select
              aria-label={t`Table to go through`}
              className="h-8 w-56 text-xs"
              value={action.tableId}
              onChange={(event) =>
                props.onChange({
                  type: "for_each",
                  tableId: event.target.value,
                  limit: action.limit,
                  actions: [defaultStep("update_record", event.target.value)],
                })
              }
            >
              {table.tables.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-1">
              {t`at most`}
              <Input
                type="number"
                aria-label={t`Number of rows at most`}
                className="h-8 w-20 text-xs"
                min={1}
                max={MAX_LOOP_ROWS}
                value={action.limit}
                onChange={(event) =>
                  props.onChange({
                    ...action,
                    limit: Math.min(
                      MAX_LOOP_ROWS,
                      Math.max(1, Number(event.target.value) || 1),
                    ),
                  })
                }
              />
              {t`rows`}
            </label>
          </div>
          <span className="text-xs text-muted-foreground">{t`That match (optional):`}</span>
          <FilterBuilder
            group={action.filter ?? EMPTY_FILTER}
            columns={target?.columns ?? []}
            people={table.people}
            onChange={(filter: FilterGroup) =>
              props.onChange({
                ...action,
                filter: filter.conditions.length > 0 ? filter : undefined,
              })
            }
          />
          <span className="text-xs text-muted-foreground">{t`For each one:`}</span>
          <StepsEditor
            steps={action.actions}
            columns={target?.columns ?? []}
            tableId={action.tableId}
            onChange={(actions) => props.onChange({ ...action, actions })}
          />
        </div>
      );
    }
    case "create_record": {
      const target = table.tables.find((item) => item.id === action.tableId);
      return (
        <div className="flex flex-col gap-2">
          <Select
            aria-label={t`Table`}
            className="h-8 w-56 text-xs"
            value={action.tableId}
            onChange={(event) =>
              props.onChange({
                ...action,
                tableId: event.target.value,
                values: {},
              })
            }
          >
            {table.tables.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          <ValuesEditor
            columns={writable(target?.columns ?? [])}
            values={action.values}
            onChange={(values) => props.onChange({ ...action, values })}
          />
        </div>
      );
    }
    case "send_email":
      return (
        <div className="flex flex-col gap-1">
          <Input
            aria-label={t`Recipients`}
            placeholder={t`Recipients, separated by commas`}
            className="h-8 text-xs"
            value={action.to}
            onChange={(event) =>
              props.onChange({ ...action, to: event.target.value })
            }
          />
          <Input
            aria-label={t`Subject`}
            placeholder={t`Subject`}
            className="h-8 text-xs"
            value={action.subject}
            onChange={(event) =>
              props.onChange({ ...action, subject: event.target.value })
            }
          />
          <Textarea
            aria-label={t`Message`}
            className="min-h-20 text-xs"
            value={action.body}
            onChange={(event) =>
              props.onChange({ ...action, body: event.target.value })
            }
          />
        </div>
      );
    case "call_webhook":
      return (
        <div className="flex flex-col gap-1">
          <Input
            aria-label={t`URL`}
            className="h-8 text-xs"
            value={action.url}
            onChange={(event) =>
              props.onChange({ ...action, url: event.target.value })
            }
          />
          <Textarea
            aria-label={t`Request body`}
            placeholder={t`Empty: the row as JSON`}
            className="min-h-16 font-mono text-xs"
            value={action.body ?? ""}
            onChange={(event) =>
              props.onChange({
                ...action,
                body: event.target.value || undefined,
              })
            }
          />
        </div>
      );
    case "notify":
      return (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-3 text-xs">
            {[...table.people.values()].map((person) => (
              <label key={person.id} className="flex items-center gap-1">
                <Checkbox
                  checked={action.users.includes(person.id)}
                  onChange={(event) =>
                    props.onChange({
                      ...action,
                      users: event.target.checked
                        ? [...action.users, person.id]
                        : action.users.filter((id) => id !== person.id),
                    })
                  }
                />
                {person.displayName}
              </label>
            ))}
          </div>
          <Input
            aria-label={t`Message`}
            placeholder={t`Message`}
            className="h-8 text-xs"
            maxLength={300}
            value={action.message}
            onChange={(event) =>
              props.onChange({ ...action, message: event.target.value })
            }
          />
        </div>
      );
  }
}

function TriggerEditor(props: {
  trigger: AutomationTrigger;
  onChange: (trigger: AutomationTrigger) => void;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const table = useTable();
  const views = useQuery(
    api.catalog.views.queryOptions({ tableId: table.table.id }),
  );
  const { trigger } = props;
  const days = [
    t`Sunday`,
    t`Monday`,
    t`Tuesday`,
    t`Wednesday`,
    t`Thursday`,
    t`Friday`,
    t`Saturday`,
  ];
  switch (trigger.type) {
    case "row_created":
      return null;
    case "row_deleted":
      return (
        <p className="text-xs text-muted-foreground">
          {t`Texts read the row's id and, for an AnyGridDB table, its values from before the deletion.`}
        </p>
      );
    case "webhook":
      return (
        <p className="text-xs text-muted-foreground">
          {t`A secret address is created when you save. A JSON POST (64 KiB at most) triggers it; each field of the body becomes a variable, listed below.`}
        </p>
      );
    case "row_updated":
      return (
        <fieldset className="flex flex-wrap gap-3 text-xs">
          <legend className="mb-1 text-xs text-muted-foreground">
            {t`Watched fields (none: all)`}
          </legend>
          {table.columns.map((column) => (
            <label key={column.name} className="flex items-center gap-1">
              <Checkbox
                checked={trigger.columns?.includes(column.name) ?? false}
                onChange={(event) =>
                  props.onChange({
                    ...trigger,
                    columns: event.target.checked
                      ? [...(trigger.columns ?? []), column.name]
                      : (trigger.columns ?? []).filter(
                          (name) => name !== column.name,
                        ),
                  })
                }
              />
              {column.label}
            </label>
          ))}
        </fieldset>
      );
    case "enters_filter":
      return (
        <FilterBuilder
          group={trigger.filter}
          columns={table.columns}
          people={table.people}
          onChange={(filter: FilterGroup) =>
            props.onChange({ ...trigger, filter })
          }
        />
      );
    case "form_submitted":
      return (
        <Select
          aria-label={t`Form`}
          className="h-8 w-64 text-xs"
          value={trigger.viewId ?? ""}
          onChange={(event) =>
            props.onChange({
              ...trigger,
              viewId: event.target.value || undefined,
            })
          }
        >
          <option value="">{t`Any form of the table`}</option>
          {(views.data?.views ?? [])
            .filter((view) => view.viewType === "form")
            .map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
        </Select>
      );
    case "schedule":
      return (
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <Select
            aria-label={t`Frequency`}
            className="h-8 w-36 text-xs"
            value={trigger.every}
            onChange={(event) => {
              const every = event.target.value as "hour" | "day" | "week";
              props.onChange({
                ...trigger,
                every,
                weekday: every === "week" ? (trigger.weekday ?? 1) : undefined,
              });
            }}
          >
            <option value="hour">{t`Every hour`}</option>
            <option value="day">{t`Every day`}</option>
            <option value="week">{t`Every week`}</option>
          </Select>
          {trigger.every === "week" ? (
            <Select
              aria-label={t`Day`}
              className="h-8 w-32 text-xs"
              value={String(trigger.weekday ?? 1)}
              onChange={(event) =>
                props.onChange({
                  ...trigger,
                  weekday: Number(event.target.value),
                })
              }
            >
              {days.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </Select>
          ) : null}
          <Input
            aria-label={t`Time`}
            type="time"
            className="h-8 w-28 text-xs"
            value={trigger.at}
            onChange={(event) =>
              props.onChange({ ...trigger, at: event.target.value })
            }
          />
          <span className="text-muted-foreground">{trigger.timeZone}</span>
        </div>
      );
    case "button":
      return (
        <Select
          aria-label={t`Button`}
          className="h-8 w-56 text-xs"
          value={trigger.column}
          onChange={(event) =>
            props.onChange({ ...trigger, column: event.target.value })
          }
        >
          {table.columns
            .filter((column) => column.fieldType === "button")
            .map((column) => (
              <option key={column.name} value={column.name}>
                {column.label}
              </option>
            ))}
        </Select>
      );
  }
}

function AutomationEditor(props: {
  initial: Automation | null;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const table = useTable();
  const labels = useLabels();
  const [name, setName] = useState(props.initial?.name ?? "");
  const [trigger, setTrigger] = useState<AutomationTrigger>(
    props.initial?.trigger ?? { type: "row_created" },
  );
  const [actions, setActions] = useState<AutomationAction[]>(
    props.initial?.actions ?? [defaultAction("update_record", table.table.id)],
  );
  const [busy, setBusy] = useState(false);
  /** A webhook's new address: shown once, here. */
  const [address, setAddress] = useState<string | null>(null);
  const hasButton = table.columns.some(
    (column) => column.fieldType === "button",
  );
  const rowless = ROWLESS.has(trigger.type);

  async function save() {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        enabled: props.initial?.enabled ?? true,
        trigger,
        actions,
      };
      const saved = props.initial
        ? await trpc.automations.update.mutate({
            automationId: props.initial.id,
            ...body,
          })
        : await trpc.automations.create.mutate({
            tableId: table.table.id,
            ...body,
          });
      if (saved.webhookUrl) {
        setAddress(saved.webhookUrl);
        return;
      }
      props.onDone();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function renew() {
    if (!props.initial) return;
    try {
      const renewed = await trpc.automations.renewWebhook.mutate({
        automationId: props.initial.id,
      });
      setAddress(renewed.webhookUrl);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  if (address) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>{t`Here is this webhook's address. Copy it now: it will not be shown again.`}</p>
        <div className="flex gap-2">
          <Input
            readOnly
            aria-label={t`Webhook address`}
            value={address}
            onFocus={(event) => event.target.select()}
          />
          <Button
            size="icon"
            variant="outline"
            aria-label={t`Copy the address`}
            onClick={() => {
              void navigator.clipboard
                .writeText(address)
                .then(() => toast.success(t`Address copied`));
            }}
          >
            <Copy className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={props.onDone}>{t`Done`}</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1 text-sm">
      <div className="flex flex-col gap-1">
        <Label htmlFor="automation-name">{t`Name`}</Label>
        <Input
          id="automation-name"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <section className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <Label htmlFor="automation-trigger">{t`When`}</Label>
        <Select
          id="automation-trigger"
          className="w-full max-w-sm"
          value={trigger.type}
          onChange={(event) => {
            const next = defaultTrigger(
              event.target.value as TriggerType,
              table.columns,
            );
            setTrigger(next);
            // A trigger without a row cannot keep actions about one.
            if (ROWLESS.has(next.type)) {
              setActions((current) =>
                current.map((action) =>
                  ROW_ACTIONS.has(action.type)
                    ? defaultAction("send_email", table.table.id)
                    : action,
                ),
              );
            }
          }}
        >
          {TRIGGERS.filter((type) => type !== "button" || hasButton).map(
            (type) => (
              <option key={type} value={type}>
                {labels.trigger(type)}
              </option>
            ),
          )}
        </Select>
        <TriggerEditor trigger={trigger} onChange={setTrigger} />
        {trigger.type === "webhook" &&
        props.initial?.trigger.type === "webhook" ? (
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            onClick={() => void renew()}
          >
            {t`New address (the old one stops working)`}
          </Button>
        ) : null}
      </section>
      {actions.map((action, index) => (
        <section
          key={index}
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t`Then (${{ index: index + 1 }})`}
            </span>
            <Select
              aria-label={t`Action`}
              className="h-8 w-60 text-xs"
              value={action.type}
              onChange={(event) =>
                setActions((current) =>
                  current.map((item, at) =>
                    at === index
                      ? defaultAction(
                          event.target.value as ActionType,
                          table.table.id,
                        )
                      : item,
                  ),
                )
              }
            >
              {ACTIONS.filter((type) => !rowless || !ROW_ACTIONS.has(type)).map(
                (type) => (
                  <option key={type} value={type}>
                    {labels.action(type)}
                  </option>
                ),
              )}
            </Select>
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto"
              aria-label={t`Remove action`}
              disabled={actions.length === 1}
              onClick={() =>
                setActions((current) => current.filter((_, at) => at !== index))
              }
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <ActionEditor
            action={action}
            onChange={(next) =>
              setActions((current) =>
                current.map((item, at) => (at === index ? next : item)),
              )
            }
          />
        </section>
      ))}
      {actions.length < MAX_AUTOMATION_ACTIONS ? (
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setActions((current) => [
                ...current,
                defaultAction(
                  rowless ? "send_email" : "update_record",
                  table.table.id,
                ),
              ])
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t`Add an action`}
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t`Values you can use in texts:`}{" "}
        <code>
          {[
            ...TEMPLATE_KEYS,
            ...table.columns.map((column) => column.name),
            ...(trigger.type === "webhook"
              ? ["body", `body_<${t`field`}>`]
              : []),
          ]
            .map((key) => `{{${key}}}`)
            .join(" ")}
        </code>
        .{" "}
        {t`The automation acts with your access; every write is recorded in the audit trail.`}
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={props.onDone}>
          {t`Cancel`}
        </Button>
        <Button onClick={() => void save()} disabled={busy || !name.trim()}>
          {busy ? <Spinner /> : null}
          {t`Save`}
        </Button>
      </DialogFooter>
    </div>
  );
}

function RunsList({ automationId }: { automationId: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const runs = useQuery(
    api.automations.runs.queryOptions({ automationId, limit: 50 }),
  );
  const status = (value: string) =>
    value === "success"
      ? t`Succeeded`
      : value === "failed"
        ? t`Failed`
        : t`Skipped`;
  return (
    <div className="max-h-[50vh] overflow-auto">
      {runs.isLoading ? <Spinner /> : null}
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted text-left">
          <tr>
            <th className="px-2 py-1">{t`Date`}</th>
            <th className="px-2 py-1">{t`Trigger`}</th>
            <th className="px-2 py-1">{t`Result`}</th>
            <th className="px-2 py-1">{t`By`}</th>
          </tr>
        </thead>
        <tbody>
          {(runs.data?.runs ?? []).map((run) => (
            <tr key={run.id} className="border-t border-border">
              <td className="px-2 py-1 whitespace-nowrap">
                {new Date(run.startedAt).toLocaleString()}
              </td>
              <td className="px-2 py-1">{run.trigger}</td>
              <td className="px-2 py-1">
                {status(run.status)}
                {run.error ? ` · ${errorText(run.error)}` : ""}
              </td>
              <td className="px-2 py-1">{run.triggeredBy ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.data?.runs.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">{t`No runs yet.`}</p>
      ) : null}
    </div>
  );
}

/** Automations of the current table: list, switch, run log, and editor. */
export function AutomationsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const table = useTable();
  const labels = useLabels();
  const options = api.automations.list.queryOptions({
    tableId: table.table.id,
  });
  const list = useQuery(options);
  const [mode, setMode] = useState<
    | { kind: "list" }
    | { kind: "edit"; automation: Automation | null }
    | { kind: "runs"; automation: Automation }
  >({ kind: "list" });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: options.queryKey });
  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  const title =
    mode.kind === "edit"
      ? mode.automation
        ? t`Edit automation`
        : t`New automation`
      : mode.kind === "runs"
        ? t`Runs of “${{ name: mode.automation.name }}”`
        : t`Automations of ${{ table: table.table.name }}`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={title} wide>
        {mode.kind === "edit" ? (
          <AutomationEditor
            initial={mode.automation}
            onDone={() => {
              setMode({ kind: "list" });
              void refresh();
            }}
          />
        ) : mode.kind === "runs" ? (
          <>
            <RunsList automationId={mode.automation.id} />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setMode({ kind: "list" })}>
                {t`Back`}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="flex min-h-0 flex-col gap-2">
            {list.isLoading ? <Spinner /> : null}
            <ul className="divide-y divide-border overflow-y-auto text-sm">
              {(list.data?.automations ?? []).map((automation) => (
                <li
                  key={automation.id}
                  className="flex items-center gap-2 py-2"
                >
                  <Checkbox
                    aria-label={t`Active`}
                    checked={automation.enabled}
                    onChange={(event) =>
                      void act(() =>
                        trpc.automations.setEnabled.mutate({
                          automationId: automation.id,
                          enabled: event.target.checked,
                        }),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{automation.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {labels.trigger(automation.trigger.type)} →{" "}
                      {automation.actions
                        .map((action) => labels.action(action.type))
                        .join(", ")}
                      {automation.lastRunAt
                        ? ` · ${t`last run ${{ date: new Date(automation.lastRunAt).toLocaleString() }}`}`
                        : ""}
                    </p>
                  </div>
                  {automation.trigger.type === "schedule" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t`Run now`}
                      onClick={() =>
                        void act(async () => {
                          const result = await trpc.automations.runNow.mutate({
                            automationId: automation.id,
                          });
                          if (result.status === "success")
                            toast.success(t`Done`);
                          else
                            toast.error(
                              t`Failed: ${{ error: result.error ? errorText(result.error) : "—" }}`,
                            );
                        })
                      }
                    >
                      <Play className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : null}
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t`Runs`}
                    onClick={() => setMode({ kind: "runs", automation })}
                  >
                    <History className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t`Edit`}
                    onClick={() => setMode({ kind: "edit", automation })}
                  >
                    <Pencil className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t`Delete`}
                    onClick={() =>
                      void act(() =>
                        trpc.automations.delete.mutate({
                          automationId: automation.id,
                        }),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            {list.data?.automations.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t`No automations on this table.`}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {t`Close`}
              </Button>
              <Button
                onClick={() => setMode({ kind: "edit", automation: null })}
              >
                <Plus className="h-4 w-4" aria-hidden />
                {t`New automation`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
