import type { FilterGroup } from "@anygriddb/core";
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
} from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Plus, Send, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import type { CatalogColumn, Collaborator } from "../../lib/types";
import { countConditions, FilterBuilder } from "../table/filter-builder";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

const EVENTS = ["insert", "update", "delete", "status", "import"] as const;
type HookEvent = (typeof EVENTS)[number];

function useEventLabel() {
  const { t } = useLingui();
  return (event: string) =>
    event === "insert"
      ? t`Creation`
      : event === "update"
        ? t`Edit`
        : event === "delete"
          ? t`Delete`
          : event === "status"
            ? t`Status change`
            : event === "import"
              ? t`Import`
              : event === "test"
                ? t`Test`
                : event;
}

function DeliveriesDialog(props: { webhookId: string; onClose: () => void }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const eventLabel = useEventLabel();
  const options = api.catalog.webhookDeliveries.queryOptions({
    webhookId: props.webhookId,
    limit: 50,
  });
  const deliveries = useQuery(options);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        title={t`Delivery log`}
        description={t`Deliveries are kept for 30 days. A failed delivery is retried three times.`}
        wide
      >
        {deliveries.isLoading ? <Spinner /> : null}
        <div className="max-h-[56vh] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted text-left">
              <tr>
                <th className="px-2 py-1">{t`Date`}</th>
                <th className="px-2 py-1">{t`Event`}</th>
                <th className="px-2 py-1">{t`Result`}</th>
                <th className="px-2 py-1">{t`Attempts`}</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {(deliveries.data?.deliveries ?? []).map((delivery) => (
                <tr key={delivery.id} className="border-t border-border">
                  <td className="px-2 py-1 whitespace-nowrap">
                    {new Date(delivery.createdAt).toLocaleString()}
                  </td>
                  <td className="px-2 py-1">{eventLabel(delivery.event)}</td>
                  <td className="px-2 py-1">
                    {delivery.status === "success"
                      ? t`Sent (${{ status: delivery.responseStatus ?? "—" }})`
                      : delivery.status === "pending"
                        ? t`Retry scheduled (${{ error: delivery.error ? errorText(delivery.error) : "—" }})`
                        : t`Failed (${{ error: delivery.error ? errorText(delivery.error) : "—" }})`}
                  </td>
                  <td className="px-2 py-1 tabular-nums">
                    {delivery.attempts}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {delivery.status === "failed" && delivery.retryable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await trpc.catalog.retryDelivery.mutate({
                              deliveryId: delivery.id,
                            });
                            toast.success(t`Delivery queued again`);
                            await queryClient.invalidateQueries({
                              queryKey: options.queryKey,
                            });
                          } catch (cause) {
                            toast.error(errorText(cause));
                          }
                        }}
                      >
                        {t`Send again`}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {deliveries.data?.deliveries.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t`No deliveries yet.`}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={props.onClose}>{t`Close`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewWebhookForm(props: {
  tableId: string;
  columns: readonly CatalogColumn[];
  people: ReadonlyMap<string, Collaborator>;
  onCreated: (secret: string) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const eventLabel = useEventLabel();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "smtp">("http");
  const [target, setTarget] = useState("");
  const [events, setEvents] = useState<HookEvent[]>([
    "insert",
    "update",
    "delete",
  ]);
  const [watch, setWatch] = useState<string[]>([]);
  const [filter, setFilter] = useState<FilterGroup>({
    conjunction: "and",
    conditions: [],
  });
  const [includeValues, setIncludeValues] = useState(true);
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-dashed border-border p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          const created = await trpc.catalog.createWebhook.mutate({
            tableId: props.tableId,
            name: name.trim() || undefined,
            kind,
            target: target.trim(),
            events,
            watchColumns: watch.length > 0 ? watch : undefined,
            filter: countConditions(filter) > 0 ? filter : undefined,
            includeValues,
            headers:
              kind === "http" && headerName.trim()
                ? { [headerName.trim()]: headerValue }
                : undefined,
          });
          props.onCreated(created.secret);
          setName("");
          setTarget("");
          setWatch([]);
          setFilter({ conjunction: "and", conditions: [] });
          setHeaderName("");
          setHeaderValue("");
        } catch (cause) {
          toast.error(errorText(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`hook-name-${props.tableId}`}>{t`Name`}</Label>
          <Input
            id={`hook-name-${props.tableId}`}
            className="w-40"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`hook-kind-${props.tableId}`}>{t`Channel`}</Label>
          <Select
            id={`hook-kind-${props.tableId}`}
            className="w-28"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value === "smtp" ? "smtp" : "http")
            }
          >
            <option value="http">HTTPS</option>
            <option value="smtp">{t`Email`}</option>
          </Select>
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor={`hook-target-${props.tableId}`}>{t`Target`}</Label>
          <Input
            id={`hook-target-${props.tableId}`}
            placeholder={
              kind === "http" ? "https://example.com/hook" : "ops@example.com"
            }
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </div>
      </div>
      <fieldset className="flex flex-wrap gap-3 text-xs">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          {t`Events`}
        </legend>
        {EVENTS.map((item) => (
          <label key={item} className="flex items-center gap-1">
            <Checkbox
              checked={events.includes(item)}
              onChange={(change) =>
                setEvents((current) =>
                  change.target.checked
                    ? [...current, item]
                    : current.filter((value) => value !== item),
                )
              }
            />
            {eventLabel(item)}
          </label>
        ))}
      </fieldset>
      {events.includes("update") ? (
        <fieldset className="flex flex-wrap gap-3 text-xs">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">
            {t`Watched fields (none checked: all)`}
          </legend>
          {props.columns.map((column) => (
            <label key={column.name} className="flex items-center gap-1">
              <Checkbox
                checked={watch.includes(column.name)}
                onChange={(change) =>
                  setWatch((current) =>
                    change.target.checked
                      ? [...current, column.name]
                      : current.filter((value) => value !== column.name),
                  )
                }
              />
              {column.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t`Row condition (creations, updates, statuses)`}
        </span>
        <FilterBuilder
          group={filter}
          columns={props.columns}
          people={props.people}
          onChange={setFilter}
        />
      </div>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={includeValues}
          onChange={(event) => setIncludeValues(event.target.checked)}
        />
        {t`Include the row's values, read with your access`}
      </label>
      {kind === "http" ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`hook-header-${props.tableId}`}>
              {t`HTTP header`}
            </Label>
            <Input
              id={`hook-header-${props.tableId}`}
              className="w-44"
              placeholder="Authorization"
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
            />
          </div>
          <Input
            aria-label={t`Header value`}
            className="min-w-48 flex-1"
            type="password"
            autoComplete="off"
            value={headerValue}
            onChange={(event) => setHeaderValue(event.target.value)}
          />
        </div>
      ) : null}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={busy || !target.trim() || events.length === 0}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t`Add webhook`}
        </Button>
      </div>
    </form>
  );
}

/** Webhooks of one table: list, switch, test, delivery log, and creation. */
export function WebhooksPanel(props: {
  tableId: string;
  columns: readonly CatalogColumn[];
  people: ReadonlyMap<string, Collaborator>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const eventLabel = useEventLabel();
  const hooks = useQuery(
    api.catalog.webhooks.queryOptions({ tableId: props.tableId }),
  );
  const [secret, setSecret] = useState("");
  const [journal, setJournal] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const labels = useMemo(
    () => new Map(props.columns.map((column) => [column.name, column.label])),
    [props.columns],
  );
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.catalog.webhooks.queryKey({ tableId: props.tableId }),
    });
  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-border text-sm">
        {(hooks.data?.webhooks ?? []).map((hook) => (
          <li key={hook.id} className="flex flex-col gap-1 py-2">
            <div className="flex items-center gap-2">
              <span className="rounded bg-muted px-1.5 text-xs uppercase">
                {hook.kind}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {hook.name ? (
                  <strong className="mr-1">{hook.name}</strong>
                ) : null}
                <span className="text-muted-foreground">{hook.target}</span>
              </span>
              <label className="flex items-center gap-1 text-xs">
                <Checkbox
                  checked={hook.active}
                  onChange={(event) =>
                    void act(() =>
                      trpc.catalog.updateWebhook.mutate({
                        webhookId: hook.id,
                        active: event.target.checked,
                      }),
                    )
                  }
                />
                {t`Active`}
              </label>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t`Send a test`}
                onClick={async () => {
                  try {
                    const result = await trpc.catalog.testWebhook.mutate({
                      webhookId: hook.id,
                    });
                    if (result.ok)
                      toast.success(
                        t`Test sent (${{ status: result.status ?? "—" }})`,
                      );
                    else
                      toast.error(
                        t`Test failed: ${{ error: result.error ? errorText(result.error) : "—" }}`,
                      );
                  } catch (cause) {
                    toast.error(errorText(cause));
                  }
                }}
              >
                <Send className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t`Delivery log`}
                onClick={() => setJournal(hook.id)}
              >
                <History className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t`Delete`}
                onClick={() =>
                  void act(() =>
                    trpc.catalog.deleteWebhook.mutate({ webhookId: hook.id }),
                  )
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {hook.events.map(eventLabel).join(", ")}
              {hook.watchColumns?.length
                ? ` · ${t`when changed: ${{
                    fields: hook.watchColumns
                      .map((name) => labels.get(name) ?? name)
                      .join(", "),
                  }}`}`
                : ""}
              {hook.filter ? ` · ${t`with a condition`}` : ""}
              {hook.hasHeaders ? ` · ${t`custom headers`}` : ""}
              {!hook.includeValues ? ` · ${t`without values`}` : ""}
              {hook.createdBy
                ? ` · ${t`created by ${{ name: hook.createdBy }}`}`
                : ""}
            </p>
            {!hook.active && hook.disabledReason ? (
              <p className="text-xs text-red-600">
                {t`Turned off after ${{ count: hook.failureCount }} failures in a row.`}
              </p>
            ) : hook.failureCount > 0 ? (
              <p className="text-xs text-amber-600">
                {t`${{ count: hook.failureCount }} failures in a row`}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {adding ? (
        <NewWebhookForm
          tableId={props.tableId}
          columns={props.columns}
          people={props.people}
          onCreated={(value) => {
            setSecret(value);
            setAdding(false);
            void refresh();
          }}
        />
      ) : (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t`New webhook`}
          </Button>
        </div>
      )}
      {secret ? (
        <p className="text-xs">
          {t`Signing secret, shown once:`} <code>{secret}</code>
        </p>
      ) : null}
      {journal ? (
        <DeliveriesDialog
          webhookId={journal}
          onClose={() => setJournal(null)}
        />
      ) : null}
    </div>
  );
}
