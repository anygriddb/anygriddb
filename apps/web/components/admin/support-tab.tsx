import { Button, Label, Select, Spinner } from "@anygriddb/ui";
import { JOB_STATUSES, type JobKind, type JobStatus } from "@anygriddb/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { Download, Mail } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { datedName, downloadCsv, downloadJson } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * Helping people (ADR 0042): every person's jobs, webhook deliveries that
 * gave up, pending invitations, and what to send to whoever helps.
 */
export function SupportTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JobStatus | "">("");
  const [withdraw, setWithdraw] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const jobs = useQuery(
    api.admin.jobs.queryOptions({ status: status || undefined, limit: 50 }),
  );
  const deliveries = useQuery(
    api.admin.failedDeliveries.queryOptions({ limit: 50 }),
  );
  const invitations = useQuery(api.admin.invitations.queryOptions());
  async function run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      await Promise.all(
        [api.admin.jobs, api.admin.invitations].map((procedure) =>
          queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
        ),
      );
      if (done) toast.success(done);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  const kindLabel = (value: JobKind) =>
    ({
      import: t`Import`,
      export: t`Export`,
      duplicate_table: t`Table copy`,
      trash_purge: t`Permanent deletion`,
      export_snapshot: t`Base export`,
      import_snapshot: t`Base import`,
      import_airtable: t`Import from Airtable`,
      duplicate_base: t`Base copy`,
    })[value];
  const statusLabel = (value: JobStatus) =>
    ({
      queued: t`Queued`,
      running: t`Running`,
      done: t`Done`,
      failed: t`Failed`,
      cancelled: t`Cancelled`,
    })[value];
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t`For whoever helps you`}</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run(async () => {
                const bundle = await trpc.admin.supportBundle.query();
                downloadJson(datedName("anygriddb-support", "json"), bundle);
              })
            }
          >
            <Download className="h-4 w-4" aria-hidden />
            {t`Download the support bundle`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run(async () => {
                const report = await trpc.admin.accessReport.mutate();
                downloadCsv(datedName("anygriddb-access", "csv"), report.csv);
              })
            }
          >
            <Download className="h-4 w-4" aria-hidden />
            {t`Export who has access`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run(async () => {
                const sent = await trpc.admin.sendTestMail.mutate();
                toast.success(t`Test email sent to ${{ to: sent.to }}`);
              })
            }
          >
            <Mail className="h-4 w-4" aria-hidden />
            {t`Send me a test email`}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t`The bundle holds health checks, counts, and which features are set up: no data, no address, no secret. The access export lists every account, its bases and roles, and its last sign-in.`}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-sm font-semibold">{t`Jobs`}</h2>
          <div className="flex flex-col gap-1">
            <Label htmlFor="support-job-status">{t`Status`}</Label>
            <Select
              id="support-job-status"
              className="w-40"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as JobStatus | "")
              }
            >
              <option value="">{t`All`}</option>
              {JOB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {jobs.isLoading ? <Spinner /> : null}
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-2 py-1.5">{t`Started`}</th>
                <th className="px-2 py-1.5">{t`Person`}</th>
                <th className="px-2 py-1.5">{t`Kind`}</th>
                <th className="px-2 py-1.5">{t`Table`}</th>
                <th className="px-2 py-1.5">{t`Status`}</th>
                <th className="px-2 py-1.5">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(jobs.data?.jobs ?? []).map((job) => (
                <tr key={job.id} className="border-t border-border">
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {date(job.createdAt)}
                  </td>
                  <td className="px-2 py-1.5">{job.userName ?? "—"}</td>
                  <td className="px-2 py-1.5">{kindLabel(job.kind)}</td>
                  <td className="px-2 py-1.5">{job.tableName ?? "—"}</td>
                  <td className="px-2 py-1.5">
                    {statusLabel(job.status)}
                    {job.status === "running" && job.total ? (
                      <span className="text-muted-foreground tabular-nums">
                        {" "}
                        · {job.done}/{job.total}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {job.status === "queued" || job.status === "running" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(
                            () =>
                              trpc.admin.cancelJob.mutate({ jobId: job.id }),
                            t`Job cancelled`,
                          )
                        }
                      >
                        {t`Cancel`}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t`Webhook deliveries that failed`}</h2>
        {deliveries.isLoading ? <Spinner /> : null}
        {deliveries.data?.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t`None.`}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-2 py-1.5">{t`Date`}</th>
                  <th className="px-2 py-1.5">{t`Webhook`}</th>
                  <th className="px-2 py-1.5">{t`Event`}</th>
                  <th className="px-2 py-1.5">{t`Attempts`}</th>
                  <th className="px-2 py-1.5">{t`Error`}</th>
                </tr>
              </thead>
              <tbody>
                {(deliveries.data?.deliveries ?? []).map((delivery) => (
                  <tr key={delivery.id} className="border-t border-border">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {date(delivery.createdAt)}
                    </td>
                    <td className="px-2 py-1.5">
                      {delivery.webhookName}
                      {delivery.host ? (
                        <span className="block text-muted-foreground">
                          {delivery.host}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 font-mono">{delivery.event}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {delivery.attempts}
                    </td>
                    <td className="px-2 py-1.5">{delivery.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t`Pending invitations`}</h2>
        <p className="text-xs text-muted-foreground">
          {t`A base's owners invite people. You can withdraw an invitation sent by mistake.`}
        </p>
        {invitations.isLoading ? <Spinner /> : null}
        {invitations.data?.invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t`None.`}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-2 py-1.5">{t`Email`}</th>
                  <th className="px-2 py-1.5">{t`Base`}</th>
                  <th className="px-2 py-1.5">{t`Role`}</th>
                  <th className="px-2 py-1.5">{t`Invited by`}</th>
                  <th className="px-2 py-1.5">{t`Expires`}</th>
                  <th className="px-2 py-1.5">
                    <span className="sr-only">{t`Actions`}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(invitations.data?.invitations ?? []).map((invitation) => (
                  <tr key={invitation.id} className="border-t border-border">
                    <td className="px-2 py-1.5">{invitation.email}</td>
                    <td className="px-2 py-1.5">{invitation.baseName}</td>
                    <td className="px-2 py-1.5">{invitation.role}</td>
                    <td className="px-2 py-1.5">
                      {invitation.invitedByName ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {date(invitation.expiresAt)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setWithdraw({
                            id: invitation.id,
                            email: invitation.email,
                          })
                        }
                      >
                        {t`Withdraw`}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {withdraw ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setWithdraw(null)}
          title={t`Withdraw the invitation to ${{ email: withdraw.email }}?`}
          description={t`The link stops working. The base's owners can invite this person again.`}
          confirmLabel={t`Withdraw`}
          onConfirm={() =>
            run(
              () =>
                trpc.admin.withdrawInvitation.mutate({
                  invitationId: withdraw.id,
                }),
              t`Invitation withdrawn`,
            )
          }
        />
      ) : null}
    </div>
  );
}
