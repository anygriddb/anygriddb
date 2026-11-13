import { Checkbox, Select, Spinner } from "@anygriddb/ui";
import type { AlertKind, InstanceSettingsPatch } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { formatBytes } from "../../lib/format";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";

type Alert = RouterOutputs["admin"]["alerts"]["alerts"][number];

/** What an open alert says, in the reader's words. */
export function useAlertText(): (
  alert: Pick<Alert, "kind" | "detail">,
) => string {
  const { t, i18n } = useLingui();
  const when = (value: string | number | null | undefined) =>
    typeof value === "string"
      ? new Date(value).toLocaleString(i18n.locale, {
          dateStyle: "long",
          timeStyle: "short",
        })
      : null;
  return ({ kind, detail }) => {
    switch (kind) {
      case "backup_late": {
        const last = when(detail.lastGoodAt);
        return last
          ? t`No backup has succeeded for more than ${{ hours: detail.hours }} hours. The last that did: ${{ last }}.`
          : t`No backup has succeeded yet: every one reported so far failed.`;
      }
      case "backup_failed":
        return t`The last backup failed, on ${{ when: when(detail.failedAt) ?? "" }}.`;
      case "storage_full":
        return t`The volume the files are on is ${{ percent: detail.percent }}% full.`;
      case "certificate_expiring":
        return t`The instance's certificate expires on ${{ when: when(detail.expiresAt) ?? "" }}.`;
      case "source_unreachable":
        return t`The source ${{ name: detail.name }} does not answer: its watched tables could not be read.`;
      case "failures":
        return t`${{ count: detail.count }} jobs, webhook deliveries, and automation runs failed in the last 24 hours.`;
    }
  };
}

/**
 * The backups reported to the instance, the alerts open now, and what
 * administrators are told about (ROADMAP #17, #25). A scheduled task
 * keeps the alerts in step: this page reads them.
 */
export function AlertsSection() {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const alertText = useAlertText();
  const state = useQuery({
    ...api.admin.alerts.queryOptions(),
    refetchInterval: 60_000,
  });
  const settings = useQuery(api.admin.settings.queryOptions());
  const ids = useId();
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const save = async (patch: InstanceSettingsPatch) => {
    try {
      await trpc.admin.updateSettings.mutate(patch);
      await queryClient.invalidateQueries({
        queryKey: api.admin.settings.queryKey(),
      });
      toast.success(t`Saved`);
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  const kinds: Record<AlertKind, string> = {
    backup_late: t`Backup late`,
    backup_failed: t`Backup failed`,
    storage_full: t`Storage nearly full`,
    certificate_expiring: t`Certificate close to expiry`,
    source_unreachable: t`Source out of reach`,
    failures: t`Failures piling up`,
  };
  /** A threshold chosen in a list, whose first choice turns the alert off. */
  const threshold = (
    key:
      | "alertBackupHours"
      | "alertStoragePercent"
      | "alertCertificateDays"
      | "alertFailures",
    label: string,
    choices: ReadonlyArray<[value: number, text: string]>,
  ) => {
    const value = settings.data?.[key] ?? 0;
    return (
      <li className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={`${ids}-${key}`}>{label}</label>
        <Select
          id={`${ids}-${key}`}
          className="w-44"
          value={value}
          onChange={(event) => void save({ [key]: Number(event.target.value) })}
        >
          <option value={0}>{t`Never`}</option>
          {choices.map(([choice, text]) => (
            <option key={choice} value={choice}>
              {text}
            </option>
          ))}
          {value !== 0 && !choices.some(([choice]) => choice === value) ? (
            <option value={value}>{String(value)}</option>
          ) : null}
        </Select>
      </li>
    );
  };
  if (state.isError) {
    return (
      <LoadFailed error={state.error} onRetry={() => void state.refetch()} />
    );
  }
  const backups = state.data?.backups ?? [];
  const alerts = state.data?.alerts ?? [];
  return (
    <>
      <RuledSection
        title={t`Alerts`}
        description={t`What administrators are told about: here, on the first page of Administration, and by email when it is set up, once a day at most while an alert stays open. An alert closes by itself once its cause is gone.`}
        className="text-sm"
      >
        {state.isLoading ? <Spinner /> : null}
        {state.data && alerts.length === 0 ? (
          <p className="text-muted-foreground">{t`No alert is open.`}</p>
        ) : null}
        {alerts.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {alerts.map((alert) => (
              <li
                key={alert.id}
                className="rounded-sm border border-warning/40 bg-warning-surface px-3 py-2"
              >
                <span className="font-medium">{kinds[alert.kind]}</span>
                <span className="block">{alertText(alert)}</span>
                <span className="block text-xs text-muted-foreground">
                  {t`Open since ${{ when: when(alert.openedAt) }}`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {settings.data ? (
          <ul className="mt-2 flex flex-col gap-2">
            {threshold("alertBackupHours", t`No backup has succeeded for`, [
              [12, t`12 hours`],
              [24, t`24 hours`],
              [36, t`36 hours`],
              [72, t`3 days`],
              [168, t`7 days`],
            ])}
            {threshold(
              "alertStoragePercent",
              t`The volume the files are on is full at`,
              [
                [70, "70%"],
                [80, "80%"],
                [90, "90%"],
                [95, "95%"],
              ],
            )}
            {threshold(
              "alertCertificateDays",
              t`The certificate expires within`,
              [
                [7, t`7 days`],
                [14, t`14 days`],
                [30, t`30 days`],
              ],
            )}
            {threshold(
              "alertFailures",
              t`Jobs, webhooks, and automations failed in 24 hours`,
              [
                [10, t`10 times`],
                [50, t`50 times`],
                [200, t`200 times`],
              ],
            )}
            <li>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={settings.data.alertSources}
                  onChange={(event) =>
                    void save({ alertSources: event.target.checked })
                  }
                />
                {t`A source's watched tables cannot be read`}
              </label>
            </li>
          </ul>
        ) : null}
      </RuledSection>

      <RuledSection
        title={t`Backups`}
        description={t`The last backups reported to this instance. The backup script reports each of its runs; a backup made by other means can report itself (see the operations guide).`}
        className="text-sm"
      >
        {state.data && backups.length === 0 ? (
          <p className="text-muted-foreground">
            {t`No backup has been reported yet. Until one is, no alert says that backups are late.`}
          </p>
        ) : null}
        {backups.length > 0 ? (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {backups.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                {run.succeeded ? (
                  <CheckCircle2
                    className="h-4 w-4 shrink-0 text-primary"
                    aria-hidden
                  />
                ) : (
                  <XCircle
                    className="h-4 w-4 shrink-0 text-danger"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  {run.succeeded ? t`Succeeded` : t`Failed`} ·{" "}
                  {when(run.finishedAt)}
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {run.name}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    run.bytes === null ? null : formatBytes(run.bytes),
                    run.encrypted ? t`encrypted` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </RuledSection>
    </>
  );
}
