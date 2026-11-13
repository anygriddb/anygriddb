import { Button, Checkbox, cn, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import { RuledSection } from "../shell/notebook-page";
import { AlertsSection } from "./alerts-section";
import { formatBytes } from "../../lib/format";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { known } from "../../lib/known-text";

type ReleaseStatusView = {
  current: string;
  latest: string;
  newer: boolean;
  url: string;
  checkedAt: string;
  dismissedVersion: string | null;
};

export function HealthTab() {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const health = useQuery({
    ...api.admin.health.queryOptions(),
    refetchInterval: 30_000,
  });
  const settings = useQuery(api.admin.settings.queryOptions());
  const release = useQuery(api.admin.releaseStatus.queryOptions());
  const [checkingRelease, setCheckingRelease] = useState(false);
  const data = health.data;
  const releaseStatus: ReleaseStatusView | null = release.data?.status ?? null;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.locale, {
      dateStyle: "long",
      timeStyle: "short",
    });
  const checks = data
    ? ([
        [t`Database`, data.checks.database],
        [t`Realtime`, data.checks.realtime],
        [t`File storage`, data.checks.storage],
      ] as const)
    : [];
  const saveReleaseCheck = async (releaseCheck: boolean) => {
    try {
      await trpc.admin.updateSettings.mutate({ releaseCheck });
      await queryClient.invalidateQueries({
        queryKey: api.admin.settings.queryKey(),
      });
      await queryClient.invalidateQueries({
        queryKey: api.admin.releaseStatus.queryKey(),
      });
      toast.success(
        releaseCheck ? t`Release check is on` : t`Release check is off`,
      );
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  const runReleaseCheck = async () => {
    setCheckingRelease(true);
    try {
      await trpc.admin.checkRelease.mutate();
      await queryClient.invalidateQueries({
        queryKey: api.admin.releaseStatus.queryKey(),
      });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setCheckingRelease(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button size="sm" variant="ghost" onClick={() => void health.refetch()}>
          <RefreshCw
            className={cn("h-4 w-4", health.isFetching && "animate-spin")}
            aria-hidden
          />
          {t`Refresh`}
        </Button>
      </div>
      {health.isLoading ? <Spinner /> : null}
      <ul className="grid gap-2 sm:grid-cols-3">
        {checks.map(([name, check]) => (
          <li
            key={name}
            className="flex items-center gap-2 rounded-sm border border-border p-3 text-sm"
          >
            {check.ok ? (
              <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden />
            ) : (
              <XCircle className="h-5 w-5 text-danger" aria-hidden />
            )}
            <span className="flex-1">{name}</span>
            <span className="text-xs text-muted-foreground">
              {check.ok
                ? `${check.ms} ms`
                : check.detail
                  ? t(known(check.detail))
                  : t`Error`}
            </span>
          </li>
        ))}
      </ul>
      <AlertsSection />
      <TlsCard />
      {data ? (
        <dl className="grid grid-cols-[16rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t`Version`}</dt>
          <dd>
            <span className="tabular-nums">{data.build.version}</span>
            {" · "}
            {data.build.builtAt === null ? (
              t`from sources`
            ) : (
              <>
                {data.build.commit ? (
                  <code className="font-mono text-xs" title={data.build.commit}>
                    {data.build.commit.slice(0, 12)}
                  </code>
                ) : (
                  t`commit not recorded`
                )}
                {" · "}
                {t`built ${{ date: when(data.build.builtAt) }}`}
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">{t`Newer release`}</dt>
          <dd className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={settings.data?.releaseCheck ?? false}
                disabled={!settings.data}
                onChange={(event) =>
                  void saveReleaseCheck(event.target.checked)
                }
              />
              <span>
                {t`Allow checking GitHub for a newer release (off by default)`}
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!settings.data?.releaseCheck || checkingRelease}
                onClick={() => void runReleaseCheck()}
              >
                <RefreshCw
                  className={cn("h-4 w-4", checkingRelease && "animate-spin")}
                  aria-hidden
                />
                {t`Check now`}
              </Button>
              {settings.data?.releaseCheck ? (
                releaseStatus ? (
                  releaseStatus.newer ? (
                    <a
                      className="text-sm underline underline-offset-2"
                      href={releaseStatus.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t`AnyGridDB ${{ latest: releaseStatus.latest }} is available`}
                    </a>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t`This instance is up to date`}
                    </span>
                  )
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {t`Not checked yet`}
                  </span>
                )
              ) : null}
            </div>
            {settings.data?.releaseCheck && releaseStatus ? (
              <p className="text-xs text-muted-foreground">
                {t`Last checked ${{ date: when(releaseStatus.checkedAt) }}`}
              </p>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">{t`Queued events`}</dt>
          <dd className="tabular-nums">{data.queue.events}</dd>
          <dt className="text-muted-foreground">
            {t`Pending webhook deliveries`}
          </dt>
          <dd className="tabular-nums">{data.queue.pendingDeliveries}</dd>
          <dt className="text-muted-foreground">{t`Failed deliveries (24 h)`}</dt>
          <dd className="tabular-nums">{data.queue.failedDeliveries24h}</dd>
          <dt className="text-muted-foreground">
            {t`Failed automations (24 h)`}
          </dt>
          <dd className="tabular-nums">{data.queue.failedRuns24h}</dd>
          <dt className="text-muted-foreground">{t`Jobs queued, running`}</dt>
          <dd className="tabular-nums">
            {data.queue.jobsQueued} · {data.queue.jobsRunning}
          </dd>
          <dt className="text-muted-foreground">{t`Failed jobs (24 h)`}</dt>
          <dd className="tabular-nums">{data.queue.failedJobs24h}</dd>
          <dt className="text-muted-foreground">{t`Accounts, bases, tables`}</dt>
          <dd className="tabular-nums">
            {data.counts.users} · {data.counts.bases} · {data.counts.tables}
          </dd>
          <dt className="text-muted-foreground">{t`Open sessions`}</dt>
          <dd className="tabular-nums">{data.counts.activeSessions}</dd>
          <dt className="text-muted-foreground">{t`Files`}</dt>
          <dd className="tabular-nums">
            {data.counts.files} · {formatBytes(data.counts.fileBytes)}
          </dd>
          <dt className="text-muted-foreground">{t`Memory used`}</dt>
          <dd className="tabular-nums">{formatBytes(data.memory.rssBytes)}</dd>
          <dt className="text-muted-foreground">{t`Node.js, up for`}</dt>
          <dd>
            {data.node} ·{" "}
            {t`${{ hours: Math.floor(data.uptimeSeconds / 3600) }} h`}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}

/**
 * The connection's security (ADR 0029): the certificate served, and, when
 * the instance signs it with its own authority, that authority to install
 * on each workstation, with the fingerprint to check it against.
 */
function TlsCard() {
  const { t, i18n } = useLingui();
  const api = useTRPC();
  const tls = useQuery(api.admin.tls.queryOptions());
  const data = tls.data;
  if (!data) return null;
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.locale, { dateStyle: "long" });
  return (
    <RuledSection title={t`Encrypted connection (HTTPS)`} className="text-sm">
      {data.authority ? (
        <>
          <p>
            {t`AnyGridDB signs its certificate with its own authority. Install it once on each workstation: the browser will then trust AnyGridDB, without a warning. It is valid for AnyGridDB's addresses only.`}
          </p>
          <div>
            <a
              className="inline-flex items-center gap-1 font-medium text-primary underline"
              href="/tls/authority.crt"
              download
            >
              <Download className="h-4 w-4" aria-hidden />
              {t`Download the authority`}
            </a>
          </div>
          <p className="text-xs text-muted-foreground">
            {t`Before installing it, check that its SHA-256 fingerprint is this one:`}
          </p>
          <code className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">
            {data.authority.fingerprint}
          </code>
          <p className="text-xs text-muted-foreground">
            {t`Valid until ${{ date: date(data.authority.expires) }}, for: ${{ names: data.authority.names.join(", ") }}.`}
          </p>
        </>
      ) : (
        <p>{t`The certificate is the one the operator provided.`}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {t`Certificate served, valid until ${{ date: date(data.server.expires) }}, for: ${{ names: data.server.names.join(", ") }}.`}
      </p>
      {data.passkeysEligible ? (
        <p className="text-xs text-muted-foreground">
          {t`Passkeys are available once this connection is trusted (authority installed or your own certificate).`}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t`PUBLIC_URL is an IP address: HTTPS and TOTP work; passkeys need a DNS hostname (or localhost) in PUBLIC_URL that people open. Put the IP in TLS_NAMES if it must stay on the certificate.`}
        </p>
      )}
    </RuledSection>
  );
}
