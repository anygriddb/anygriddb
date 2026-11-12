import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from "@anygriddb/ui";
import { JOB_STATUSES, type JobKind, type JobStatus } from "@anygriddb/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { Download, Mail } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { datedName, downloadJson } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { RuledSection } from "../shell/notebook-page";

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

type RecipientMode = "all_active" | "ids";

/**
 * Helping people (ADR 0042): jobs, webhook deliveries that gave up, and
 * what to send to whoever helps, and notices to accounts (ADR 0052).
 * Pending invitations sit beside the accounts (ROADMAP #20), who has
 * access beside the security policy (ROADMAP #49).
 */
export function SupportTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<JobStatus | "">("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<RecipientMode>("all_active");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [confirmSend, setConfirmSend] = useState(false);
  const [busyMail, setBusyMail] = useState(false);
  const jobs = useQuery(
    api.admin.jobs.queryOptions({ status: status || undefined, limit: 50 }),
  );
  const deliveries = useQuery(
    api.admin.failedDeliveries.queryOptions({ limit: 50 }),
  );
  const smtp = useQuery(api.admin.smtp.get.queryOptions());
  const accounts = useQuery({
    ...api.admin.users.queryOptions({
      search: search || undefined,
      offset: 0,
      limit: 50,
    }),
    enabled: mode === "ids",
  });
  const allActivePreview = useQuery({
    ...api.admin.operatorMailPreview.queryOptions({
      recipients: { mode: "all_active" },
    }),
    enabled: mode === "all_active" && Boolean(smtp.data?.ready),
  });
  const recipientCount = useMemo(() => {
    if (mode === "ids") return selected.size;
    return allActivePreview.data?.recipientCount ?? null;
  }, [mode, selected, allActivePreview.data?.recipientCount]);
  const canCompose =
    Boolean(smtp.data?.ready) &&
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    (mode === "all_active" ? (recipientCount ?? 0) > 0 : selected.size > 0);
  async function run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: api.admin.jobs.queryKey(),
      });
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
    <div className="flex flex-col gap-4">
      <RuledSection
        title={t`For whoever helps you`}
        description={t`The bundle holds the version, health checks, counts, and which features are set up: no data, no address, no secret. Who has access is exported from Security.`}
      >
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
                const sent = await trpc.admin.sendTestMail.mutate();
                toast.success(t`Test email sent to ${{ to: sent.to }}`);
              })
            }
          >
            <Mail className="h-4 w-4" aria-hidden />
            {t`Send me a test email`}
          </Button>
        </div>
      </RuledSection>

      <RuledSection
        title={t`Message accounts`}
        description={t`Email a plain-text notice about maintenance, a policy change, or an incident. This is not a newsletter: it ignores each person's notification preference.`}
      >
        {!smtp.data?.ready ? (
          <p className="text-sm text-muted-foreground">
            {t`Set up email under Connections before you can send a notice.`}
          </p>
        ) : null}
        <div className="flex flex-col gap-3 max-w-xl">
          <div className="flex flex-col gap-1">
            <Label htmlFor="operator-mail-subject">{t`Subject`}</Label>
            <Input
              id="operator-mail-subject"
              maxLength={200}
              value={subject}
              disabled={!smtp.data?.ready}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="operator-mail-body">{t`Message`}</Label>
            <Textarea
              id="operator-mail-body"
              rows={6}
              maxLength={5_000}
              value={body}
              disabled={!smtp.data?.ready}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t`Recipients`}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="operator-mail-mode"
                checked={mode === "all_active"}
                disabled={!smtp.data?.ready}
                onChange={() => setMode("all_active")}
              />
              {t`All active accounts`}
              {mode === "all_active" && recipientCount !== null ? (
                <span className="text-muted-foreground tabular-nums">
                  ({recipientCount})
                </span>
              ) : null}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="operator-mail-mode"
                checked={mode === "ids"}
                disabled={!smtp.data?.ready}
                onChange={() => setMode("ids")}
              />
              {t`Selected accounts`}
              {mode === "ids" ? (
                <span className="text-muted-foreground tabular-nums">
                  ({selected.size})
                </span>
              ) : null}
            </label>
          </fieldset>
          {mode === "ids" ? (
            <div className="flex flex-col gap-2">
              <Input
                aria-label={t`Search accounts`}
                placeholder={t`Name or email`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {accounts.isLoading ? <Spinner /> : null}
              <div className="max-h-48 overflow-y-auto rounded-sm border border-border">
                <ul className="divide-y divide-border text-sm">
                  {(accounts.data?.users ?? []).map((user) => {
                    const checked = selected.has(user.id);
                    return (
                      <li key={user.id} className="px-2 py-1.5">
                        <label className="flex items-start gap-2">
                          <Checkbox
                            checked={checked}
                            onChange={(event) => {
                              setSelected((current) => {
                                const next = new Map(current);
                                if (event.target.checked) {
                                  next.set(user.id, user.email);
                                } else {
                                  next.delete(user.id);
                                }
                                return next;
                              });
                            }}
                          />
                          <span>
                            <span className="block">{user.displayName}</span>
                            <span className="block text-xs text-muted-foreground">
                              {user.email}
                              {user.disabledAt ? ` · ${t`Disabled`}` : ""}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          ) : null}
          <div>
            <Button
              size="sm"
              disabled={!canCompose || busyMail}
              onClick={() => setConfirmSend(true)}
            >
              <Mail className="h-4 w-4" aria-hidden />
              {t`Send notice`}
            </Button>
          </div>
        </div>
      </RuledSection>

      <RuledSection title={t`Jobs`}>
        <div className="flex flex-wrap items-end justify-between gap-2">
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
        <div className="overflow-x-auto rounded-sm border border-border">
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
              {jobs.data?.jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-3 text-muted-foreground">
                    {status
                      ? t`No job with this status.`
                      : t`No job yet. Imports, exports, and copies of tables and bases show here as people start them.`}
                  </td>
                </tr>
              ) : null}
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
      </RuledSection>

      <RuledSection title={t`Webhook deliveries that failed`}>
        {deliveries.isLoading ? <Spinner /> : null}
        {deliveries.data?.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t`No delivery has failed. A webhook's delivery shows here once it gives up after its retries, with the error it got.`}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-border">
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
      </RuledSection>

      {confirmSend && recipientCount !== null && recipientCount > 0 ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmSend(false)}
          title={t`Send to ${{ count: recipientCount }} accounts?`}
          description={t`Each person receives this plain-text notice by email. The sign-in trail records that you sent it.`}
          confirmLabel={t`Send notice`}
          onConfirm={async () => {
            setBusyMail(true);
            try {
              const result = await trpc.admin.sendOperatorMail.mutate({
                subject: subject.trim(),
                body: body.trim(),
                recipients:
                  mode === "all_active"
                    ? { mode: "all_active" }
                    : {
                        mode: "ids",
                        userIds: [...selected.keys()],
                      },
              });
              toast.success(
                t`Notice queued for ${{ count: result.recipientCount }} accounts`,
              );
              setSubject("");
              setBody("");
              setSelected(new Map());
              setConfirmSend(false);
              await queryClient.invalidateQueries({
                queryKey: api.admin.operatorMailPreview.queryKey(),
              });
            } catch (cause) {
              toast.error(errorText(cause));
            } finally {
              setBusyMail(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
