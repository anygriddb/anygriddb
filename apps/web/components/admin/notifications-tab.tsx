/**
 * Notification channels (ADR 0092). The form is the provider's fields:
 * a secret is written and never shown again.
 */
import {
  DEFAULT_CHANNEL_EVENTS,
  INSTANCE_EVENT_TYPES,
  type InstanceEventType,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import { useStepUp } from "./step-up";

type Provider = RouterOutputs["admin"]["notify"]["providers"][number];
type Integration = RouterOutputs["admin"]["notify"]["list"][number];
type Field = Provider["fields"][number];

function useEventLabel() {
  const { t } = useLingui();
  return (type: InstanceEventType): string => {
    switch (type) {
      case "job.failed":
        return t`A background job failed`;
      case "job.succeeded":
        return t`A background job finished`;
      case "backup.failed":
        return t`A backup failed`;
      case "backup.succeeded":
        return t`A backup finished`;
      case "import.failed":
        return t`An import failed`;
      case "datasource.unreachable":
        return t`A source is unreachable`;
      case "datasource.recovered":
        return t`A source is reachable again`;
      case "migration.failed":
        return t`A database migration failed`;
      case "disk.low":
        return t`Disk space is low`;
      case "auth.login_failed_burst":
        return t`An account was locked after failed sign-ins`;
      case "user.created":
        return t`An account was created`;
      case "user.deleted":
        return t`An account was deleted`;
      case "integration.failing":
        return t`An integration is failing`;
      default: {
        const neverType: never = type;
        return neverType;
      }
    }
  };
}

function useProviderHelp() {
  const { t } = useLingui();
  return (id: string): string => {
    if (id === "webhook") {
      return t`AnyGridDB POSTs the event as JSON and signs those bytes with HMAC-SHA256. The signature is the x-anygrid-signature header.`;
    }
    if (id === "ntfy") {
      return t`Publishes the message to a topic. The topic is a secret. An optional token is sent as a bearer.`;
    }
    if (id === "gotify") {
      return t`Posts a message to your Gotify server with the application token.`;
    }
    if (id === "apprise") {
      return t`Posts to an Apprise API. The destination URLs are a secret and are sent in the body.`;
    }
    if (id === "smtp") {
      return t`Sends to these addresses through the mail relay configured under Connections.`;
    }
    if (id === "healthchecks") {
      return t`Pings a Healthchecks address: /start when a job starts, the address itself when it succeeds, /fail when it fails.`;
    }
    if (id === "uptime-kuma") {
      return t`Calls the push address of an Uptime Kuma monitor, with status up or down.`;
    }
    if (id === "heartbeat") {
      return t`Calls one address when a job starts, one when it succeeds, and one when it fails.`;
    }
    if (id === "matrix") {
      return t`Sends a text message to a room with an access token.`;
    }
    if (id === "mattermost" || id === "rocketchat") {
      return t`Posts the message to an incoming webhook. The address is a secret.`;
    }
    if (id === "zulip") {
      return t`Posts the message to a generic incoming webhook. The address contains the key and is a secret.`;
    }
    if (id === "alertmanager") {
      return t`Posts an alert to the Alertmanager API.`;
    }
    if (id === "metrics") {
      return t`Opens /metrics for a bearer token. The environment token wins when it is set.`;
    }
    if (id === "sentry") {
      return t`Sends internal errors to a Sentry-compatible DSN. No restart is required.`;
    }
    if (id === "otlp") {
      return t`Sends traces to an OTLP HTTP collector. A restart is asked for only when a live reload fails.`;
    }
    return "";
  };
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

function fieldValue(field: Field, raw: string): unknown {
  if (field.kind === "headers") return parseHeaders(raw);
  if (field.kind === "number") return Number(raw);
  if (field.kind === "strings") {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return raw.trim();
}

function useProviderLabel() {
  const { t } = useLingui();
  return (id: string, fallback: string): string => {
    if (id === "webhook") return t`Webhook`;
    if (id === "smtp") return t`Email`;
    if (id === "heartbeat") return t`Heartbeat URL`;
    if (id === "metrics") return t`Metrics`;
    if (id === "sentry") return t`Errors`;
    if (id === "otlp") return t`Traces`;
    return fallback;
  };
}

function useStatusLabel() {
  const { t } = useLingui();
  return (status: Integration["status"]): string => {
    if (status === "error") return t`Failing`;
    if (status === "disabled") return t`Off`;
    return t`On`;
  };
}

function ProbeCard({
  provider,
  row,
  held,
  ready,
  title,
}: {
  provider: Provider;
  row: Integration | undefined;
  held: boolean;
  ready: boolean;
  title: string;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const errorText = useErrorText();
  const providerHelp = useProviderHelp();
  const [name, setName] = useState(row?.name ?? title);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const field of provider.fields) {
      if (field.secret || !row) {
        next[field.key] = "";
        continue;
      }
      const value = row.config[field.key];
      next[field.key] = typeof value === "string" ? value : "";
    }
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (!(await stepUp.ensure())) return;
      const config: Record<string, unknown> = {};
      const secrets: Record<string, unknown> = {};
      for (const field of provider.fields) {
        const raw = values[field.key] ?? "";
        if (field.secret) {
          if (raw.trim() === "") continue;
          secrets[field.key] = fieldValue(field, raw);
          continue;
        }
        config[field.key] = fieldValue(field, raw);
      }
      const saved = row
        ? await trpc.admin.notify.update.mutate({
            id: row.id,
            name: name.trim(),
            events: [],
            schedules: [],
            config,
            secrets,
          })
        : await trpc.admin.notify.create.mutate({
            provider: provider.id,
            name: name.trim(),
            events: [],
            schedules: [],
            config,
            secrets,
          });
      setNotice(
        saved.restartRequired
          ? t`Saved. Restart the process before traces use this endpoint.`
          : provider.id === "otlp"
            ? t`Traces are being sent.`
            : null,
      );
      await queryClient.invalidateQueries({
        queryKey: api.admin.notify.list.queryKey(),
      });
      toast.success(row ? t`Integration updated` : t`Integration saved`);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <RuledSection title={title} description={providerHelp(provider.id)}>
      <p className="mb-3 text-xs text-muted-foreground">
        <a
          className="text-primary underline"
          href={provider.docsUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t`Documentation`}
        </a>
      </p>
      {!ready ? (
        <Spinner />
      ) : held ? (
        <p className="text-xs text-muted-foreground">
          {row
            ? t`Its operator changes it where the instance is installed. What was saved on this page before is not used.`
            : t`Its operator changes it where the instance is installed.`}
        </p>
      ) : (
        <form
          className="flex max-w-lg flex-col gap-3"
          onSubmit={(event) => void save(event)}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`probe-name-${provider.id}`}>{t`Name`}</Label>
            <Input
              id={`probe-name-${provider.id}`}
              required
              maxLength={80}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {provider.fields.map((field) => (
            <ProviderFieldInput
              key={field.key}
              field={field}
              value={values[field.key] ?? ""}
              kept={row?.secretsSet.includes(field.key) === true}
              onChange={(value) =>
                setValues((current) => ({ ...current, [field.key]: value }))
              }
            />
          ))}
          {row?.lastError ? (
            <p className="text-sm text-danger">{row.lastError}</p>
          ) : null}
          {notice ? <p className="text-sm">{notice}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {row ? t`Save changes` : t`Add integration`}
            </Button>
            {row && provider.id === "sentry" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void (async () => {
                    try {
                      if (!(await stepUp.ensure())) return;
                      const result = await trpc.admin.notify.test.mutate({
                        id: row.id,
                      });
                      const status =
                        result.status === null
                          ? ""
                          : `HTTP ${String(result.status)}`;
                      const detail = result.body;
                      const failure = result.error ?? status;
                      setNotice(
                        result.ok
                          ? t`Test sent. ${status} ${detail}`
                          : t`Test failed. ${failure} ${detail}`,
                      );
                    } catch (error) {
                      setNotice(errorText(error));
                    }
                  })();
                }}
              >
                {t`Send a test`}
              </Button>
            ) : null}
            {row ? (
              <Button
                type="button"
                variant="danger"
                onClick={() => setRemove(true)}
              >
                {t`Remove`}
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={remove}
        onOpenChange={setRemove}
        title={t`Remove this integration?`}
        description={t`It stops receiving events. Past deliveries are kept until they expire.`}
        confirmLabel={t`Remove`}
        danger
        onConfirm={async () => {
          if (!row) return;
          if (!(await stepUp.ensure())) return;
          const removed = await trpc.admin.notify.delete.mutate({
            id: row.id,
          });
          if (removed.restartRequired) {
            setNotice(
              t`Saved. Restart the process before traces use this endpoint.`,
            );
          }
          await queryClient.invalidateQueries({
            queryKey: api.admin.notify.list.queryKey(),
          });
        }}
      />
    </RuledSection>
  );
}

export function NotificationsTab() {
  const { t } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const errorText = useErrorText();
  const eventLabel = useEventLabel();
  const providerHelp = useProviderHelp();
  const statusLabel = useStatusLabel();
  const providers = useQuery(api.admin.notify.providers.queryOptions());
  const list = useQuery(api.admin.notify.list.queryOptions());
  const settings = useQuery(api.admin.settings.queryOptions());
  const environment = useQuery(api.admin.notify.environment.queryOptions());
  const automations = useQuery(api.admin.notify.schedules.queryOptions());
  const providerLabel = useProviderLabel();
  const [providerId, setProviderId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<InstanceEventType[]>([
    ...DEFAULT_CHANNEL_EVENTS,
  ]);
  const [schedules, setSchedules] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [testOf, setTestOf] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const history = useQuery({
    ...api.admin.notify.deliveries.queryOptions({ id: historyOf ?? "" }),
    enabled: historyOf !== null,
  });

  if (providers.isError) {
    return (
      <LoadFailed
        error={providers.error}
        onRetry={() => void providers.refetch()}
      />
    );
  }
  if (list.isError) {
    return (
      <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
    );
  }
  if (!providers.data || !list.data) return <Spinner />;

  const addable = providers.data.filter((item) => !item.singleton);
  const chosenId =
    providerId && addable.some((item) => item.id === providerId)
      ? providerId
      : (addable.find((item) => item.id === "webhook")?.id ??
        addable[0]?.id ??
        "");
  const provider = providers.data.find((item) => item.id === chosenId);
  const channels = list.data.filter((row) => {
    const kind = providers.data.find((item) => item.id === row.provider);
    return kind?.family === "channel" || kind?.family === "heartbeat";
  });
  const allowPrivate = settings.data?.notifyAllowPrivate === true;

  function resetForm() {
    setEditing(null);
    setName("");
    setValues({});
    setEvents([...DEFAULT_CHANNEL_EVENTS]);
    setSchedules([]);
    setProviderId(null);
  }

  function edit(row: Integration) {
    const match = providers.data?.find((item) => item.id === row.provider);
    setEditing(row.id);
    setProviderId(row.provider);
    setName(row.name);
    setEvents(row.events);
    setSchedules(row.schedules);
    const next: Record<string, string> = {};
    for (const field of match?.fields ?? []) {
      if (field.secret) {
        next[field.key] = "";
        continue;
      }
      const value = row.config[field.key];
      next[field.key] = Array.isArray(value)
        ? value.filter((item) => typeof item === "string").join("\n")
        : typeof value === "string"
          ? value
          : "";
    }
    setValues(next);
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!provider) return;
    setBusy(true);
    try {
      if (!(await stepUp.ensure())) return;
      const config: Record<string, unknown> = {};
      const secrets: Record<string, unknown> = {};
      for (const field of provider.fields) {
        const raw = values[field.key] ?? "";
        if (field.secret) {
          if (raw.trim() === "") continue;
          secrets[field.key] = fieldValue(field, raw);
          continue;
        }
        config[field.key] = fieldValue(field, raw);
      }
      const saved = editing
        ? await trpc.admin.notify.update.mutate({
            id: editing,
            name: name.trim(),
            events,
            schedules: provider.subscribes ? [] : schedules,
            config,
            secrets,
          })
        : await trpc.admin.notify.create.mutate({
            provider: provider.id,
            name: name.trim(),
            events,
            schedules: provider.subscribes ? [] : schedules,
            config,
            secrets,
          });
      if (saved.restartRequired) {
        toast.message(
          t`Saved. Restart the process before traces use this endpoint.`,
        );
      } else if (provider.id === "otlp") {
        toast.message(t`Traces are being sent.`);
      }
      const wasEditing = editing !== null;
      resetForm();
      await queryClient.invalidateQueries({
        queryKey: api.admin.notify.list.queryKey(),
      });
      toast.success(wasEditing ? t`Integration updated` : t`Integration saved`);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: Integration) {
    if (!(await stepUp.ensure())) return;
    try {
      const saved = await trpc.admin.notify.setEnabled.mutate({
        id: row.id,
        enabled: !row.enabled || row.status === "error",
      });
      if (saved.restartRequired) {
        toast.message(
          t`Saved. Restart the process before traces use this endpoint.`,
        );
      }
      await queryClient.invalidateQueries({
        queryKey: api.admin.notify.list.queryKey(),
      });
      await queryClient.invalidateQueries({
        queryKey: api.admin.notify.failing.queryKey(),
      });
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function sendTest(id: string) {
    setTestOf(id);
    setTestResult(null);
    try {
      if (!(await stepUp.ensure())) return;
      const result = await trpc.admin.notify.test.mutate({ id });
      const status =
        result.status === null ? "" : `HTTP ${String(result.status)}`;
      const detail = result.body;
      const failure = result.error ?? status;
      setTestResult(
        result.ok
          ? t`Test sent. ${status} ${detail}`
          : t`Test failed. ${failure} ${detail}`,
      );
      await queryClient.invalidateQueries({
        queryKey: api.admin.notify.list.queryKey(),
      });
      if (historyOf === id) {
        await queryClient.invalidateQueries({
          queryKey: api.admin.notify.deliveries.queryKey({ id }),
        });
      }
    } catch (error) {
      setTestResult(errorText(error));
    } finally {
      setTestOf(null);
    }
  }

  async function allowPrivateChange(next: boolean) {
    if (!(await stepUp.ensure())) return;
    try {
      await trpc.admin.updateSettings.mutate({ notifyAllowPrivate: next });
      await queryClient.invalidateQueries({
        queryKey: api.admin.settings.queryKey(),
      });
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  return (
    <div>
      <RuledSection
        title={t`Notifications`}
        description={t`Channels that hear when something on this instance fails. A secret is stored encrypted and is not shown again.`}
      >
        <form
          className="flex max-w-lg flex-col gap-3"
          onSubmit={(event) => void save(event)}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="notify-provider">{t`Provider`}</Label>
            <Select
              id="notify-provider"
              value={chosenId}
              disabled={editing !== null}
              onChange={(event) => {
                setProviderId(event.target.value);
                setValues({});
                setSchedules([]);
              }}
            >
              {addable.map((item) => (
                <option key={item.id} value={item.id}>
                  {providerLabel(item.id, item.label)}
                </option>
              ))}
            </Select>
            {provider ? (
              <p className="text-xs text-muted-foreground">
                {providerHelp(provider.id)}{" "}
                <a
                  className="text-primary underline"
                  href={provider.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t`Documentation`}
                </a>
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="notify-name">{t`Name`}</Label>
            <Input
              id="notify-name"
              required
              maxLength={80}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {provider?.fields.map((field) => (
            <ProviderFieldInput
              key={field.key}
              field={field}
              value={values[field.key] ?? ""}
              kept={
                editing !== null &&
                list.data.some(
                  (row) =>
                    row.id === editing && row.secretsSet.includes(field.key),
                )
              }
              onChange={(value) =>
                setValues((current) => ({ ...current, [field.key]: value }))
              }
            />
          ))}
          {provider?.family === "heartbeat" ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium text-muted-foreground">
                {t`Schedules`}
              </legend>
              {(
                [
                  ["purge", t`Hourly purge`],
                  ["audit_purge", t`Change trail purge`],
                  ["trash_purge", t`Trash purge`],
                  ["file_sweep", t`File sweep`],
                  ["backup", t`Backup report`],
                ] as const
              ).map(([id, label]) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={schedules.includes(id)}
                    onChange={(event) => {
                      const on = event.target.checked;
                      setSchedules((current) =>
                        on
                          ? [...current, id]
                          : current.filter((item) => item !== id),
                      );
                    }}
                  />
                  {label}
                </label>
              ))}
              {(automations.data ?? []).map((item) => (
                <label
                  key={item.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={schedules.includes(item.id)}
                    onChange={(event) => {
                      const on = event.target.checked;
                      setSchedules((current) =>
                        on
                          ? [...current, item.id]
                          : current.filter((entry) => entry !== item.id),
                      );
                    }}
                  />
                  {item.name}
                </label>
              ))}
            </fieldset>
          ) : null}
          {provider?.subscribes ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs font-medium text-muted-foreground">
                {t`Events`}
              </legend>
              {INSTANCE_EVENT_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={events.includes(type)}
                    onChange={(event) => {
                      const on = event.target.checked;
                      setEvents((current) =>
                        on
                          ? [...current, type]
                          : current.filter((item) => item !== type),
                      );
                    }}
                  />
                  {eventLabel(type)}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !provider}>
              {editing ? t`Save changes` : t`Add integration`}
            </Button>
            {editing ? (
              <Button type="button" variant="ghost" onClick={resetForm}>
                {t`Cancel`}
              </Button>
            ) : null}
          </div>
        </form>
      </RuledSection>
      <RuledSection
        title={t`Private networks`}
        description={t`Off, a channel can only call a public HTTPS address. On, it may also call a private address, still over HTTPS. Loopback and cloud metadata stay blocked.`}
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allowPrivate}
            onChange={(event) => void allowPrivateChange(event.target.checked)}
          />
          {t`Allow private networks`}
        </label>
      </RuledSection>
      <RuledSection
        title={t`Channels`}
        description={t`The last error is a short reason, never a secret.`}
      >
        {channels.length === 0 ? (
          <p className="rounded-sm border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
            {t`No integration yet. Add one above and send a test.`}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t`Name`}</th>
                  <th className="px-3 py-2 text-left font-medium">{t`Provider`}</th>
                  <th className="px-3 py-2 text-left font-medium">{t`State`}</th>
                  <th className="px-3 py-2 text-left font-medium">{t`Last delivery`}</th>
                  <th className="px-3 py-2 text-left font-medium">{t`Last error`}</th>
                  <th className="px-3 py-2 text-left font-medium">{t`Held back`}</th>
                  <th className="px-3 py-2 text-right font-medium">{t`Actions`}</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="px-3 py-2">{row.name}</td>
                    <td className="px-3 py-2">{row.provider}</td>
                    <td className="px-3 py-2">{statusLabel(row.status)}</td>
                    <td className="px-3 py-2">
                      {row.lastDeliveryAt
                        ? new Date(row.lastDeliveryAt).toLocaleString()
                        : t`Never`}
                    </td>
                    <td className="px-3 py-2">{row.lastError ?? ""}</td>
                    <td className="px-3 py-2">{row.suppressedCount}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => edit(row)}
                        >
                          {t`Edit`}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => void toggle(row)}
                        >
                          {row.status === "error"
                            ? t`Resume`
                            : row.enabled
                              ? t`Disable`
                              : t`Enable`}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={testOf === row.id}
                          onClick={() => void sendTest(row.id)}
                        >
                          {t`Send a test`}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setHistoryOf((current) =>
                              current === row.id ? null : row.id,
                            )
                          }
                        >
                          {t`History`}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="danger"
                          onClick={() => setRemoveId(row.id)}
                        >
                          {t`Remove`}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {testResult ? (
          <p role="status" className="mt-3 text-sm whitespace-pre-wrap">
            {testResult}
          </p>
        ) : null}
        {historyOf ? (
          <DeliveryHistory
            rows={history.data}
            loading={history.isLoading}
            error={history.error}
          />
        ) : null}
      </RuledSection>
      {(["metrics", "sentry", "otlp"] as const).map((id) => {
        const probe = providers.data.find((item) => item.id === id);
        if (!probe) return null;
        const row = list.data.find((item) => item.provider === id);
        const held =
          (id === "metrics" && environment.data?.metrics === true) ||
          (id === "otlp" && environment.data?.traces === true);
        return (
          <ProbeCard
            key={id}
            provider={probe}
            row={row}
            held={held}
            ready={id === "sentry" || environment.isFetched}
            title={providerLabel(id, probe.label)}
          />
        );
      })}
      <ConfirmDialog
        open={removeId !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveId(null);
        }}
        title={t`Remove this integration?`}
        description={t`It stops receiving events. Past deliveries are kept until they expire.`}
        confirmLabel={t`Remove`}
        danger
        onConfirm={async () => {
          if (!removeId) return;
          if (!(await stepUp.ensure())) return;
          const removed = await trpc.admin.notify.delete.mutate({
            id: removeId,
          });
          if (removed.restartRequired) {
            toast.message(
              t`Saved. Restart the process before traces use this endpoint.`,
            );
          }
          if (editing === removeId) resetForm();
          if (historyOf === removeId) setHistoryOf(null);
          await queryClient.invalidateQueries({
            queryKey: api.admin.notify.list.queryKey(),
          });
        }}
      />
    </div>
  );
}

function ProviderFieldInput({
  field,
  value,
  kept,
  onChange,
}: {
  field: Field;
  value: string;
  kept: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const id = `notify-${field.key}`;
  const label =
    field.key === "url"
      ? t`Address`
      : field.key === "secret"
        ? t`Signing secret`
        : field.key === "headers"
          ? t`Headers`
          : field.key === "server"
            ? t`Server`
            : field.key === "topic"
              ? t`Topic`
              : field.key === "token"
                ? t`Token`
                : field.key === "recipients"
                  ? t`Recipients`
                  : field.key === "urls"
                    ? t`Destination URLs`
                    : field.key === "username"
                      ? t`Username`
                      : field.key === "password"
                        ? t`Password`
                        : field.key === "homeserver"
                          ? t`Homeserver`
                          : field.key === "roomId"
                            ? t`Room`
                            : field.key === "accessToken"
                              ? t`Access token`
                              : field.key === "webhookUrl"
                                ? t`Webhook address`
                                : field.key === "pingUrl"
                                  ? t`Ping address`
                                  : field.key === "pushUrl"
                                    ? t`Push address`
                                    : field.key === "startUrl"
                                      ? t`Start address`
                                      : field.key === "successUrl"
                                        ? t`Success address`
                                        : field.key === "failUrl"
                                          ? t`Failure address`
                                          : field.key === "dsn"
                                            ? t`DSN`
                                            : field.key === "endpoint"
                                              ? t`Collector address`
                                              : field.key;
  const placeholder = kept
    ? t`Leave blank to keep the current value`
    : field.kind === "headers"
      ? t`Name: value`
      : undefined;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {field.kind === "headers" || field.kind === "strings" ? (
        <Textarea
          id={id}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={
            field.secret
              ? "password"
              : field.kind === "number"
                ? "number"
                : "text"
          }
          required={field.required && !kept}
          value={value}
          placeholder={placeholder}
          autoComplete={field.secret ? "new-password" : "off"}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.kind === "url" ? (
        <p className="text-xs text-muted-foreground">
          {t`HTTPS only. Example: https://hooks.example.com/anygriddb`}
        </p>
      ) : null}
    </div>
  );
}

function DeliveryHistory({
  rows,
  loading,
  error,
}: {
  rows: RouterOutputs["admin"]["notify"]["deliveries"] | undefined;
  loading: boolean;
  error: unknown;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  if (loading) return <Spinner />;
  if (error)
    return <p className="mt-3 text-sm text-danger">{errorText(error)}</p>;
  if (!rows || rows.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">{t`No delivery yet.`}</p>
    );
  }
  return (
    <div className="mt-3 overflow-x-auto rounded-sm border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs">
          <tr>
            <th className="px-3 py-2 text-left font-medium">{t`When`}</th>
            <th className="px-3 py-2 text-left font-medium">{t`Event`}</th>
            <th className="px-3 py-2 text-left font-medium">{t`State`}</th>
            <th className="px-3 py-2 text-left font-medium">{t`Attempts`}</th>
            <th className="px-3 py-2 text-left font-medium">{t`Error`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-border">
              <td className="px-3 py-2">
                {new Date(row.createdAt).toLocaleString()}
              </td>
              <td className="px-3 py-2">{row.event}</td>
              <td className="px-3 py-2">
                {row.status}
                {row.responseStatus !== null
                  ? ` ${String(row.responseStatus)}`
                  : ""}
              </td>
              <td className="px-3 py-2">{row.attempts}</td>
              <td className="px-3 py-2">{row.error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
