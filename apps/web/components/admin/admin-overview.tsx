import { Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTRPC } from "../../lib/trpc";
import type { AccountsSearch } from "./accounts-search";
import { useReadsAll } from "./admin-access";
import { useAlertText } from "./alerts-section";

/** Counting only: the total comes back with the first row. */
const COUNT = { offset: 0, limit: 1 } as const;

/**
 * Administration's first page (ROADMAP #26): what needs action, from what
 * the instance already counts. A card shows only while its count is not
 * zero, and opens the list that holds what it counts. The release notice
 * is the banner above every page of Administration.
 */
export function AdminOverview() {
  const { t } = useLingui();
  const readsAll = useReadsAll();
  const api = useTRPC();
  const alertText = useAlertText();
  const locked = useQuery(
    api.admin.users.queryOptions({ ...COUNT, status: "locked" }),
  );
  const unprotected = useQuery({
    ...api.admin.users.queryOptions({
      ...COUNT,
      status: "active",
      admin: true,
      mfa: false,
    }),
    enabled: readsAll,
  });
  const invitations = useQuery({
    ...api.admin.invitations.queryOptions(),
    enabled: readsAll,
  });
  const health = useQuery({
    ...api.admin.health.queryOptions(),
    enabled: readsAll,
    refetchInterval: 30_000,
  });
  const ownerless = useQuery({
    ...api.admin.baseOverview.ownerlessCount.queryOptions(),
    enabled: readsAll,
  });
  const alerts = useQuery({
    ...api.admin.alerts.queryOptions(),
    enabled: readsAll,
    refetchInterval: 60_000,
  });
  const queries = readsAll
    ? [locked, unprotected, invitations, health, ownerless, alerts]
    : [locked];
  const cards: ReactNode[] = [];
  const card = (
    count: number,
    title: string,
    detail: string,
    link: ReactNode,
  ) => {
    if (count > 0) {
      cards.push(
        <li
          key={title}
          className="flex flex-col gap-1 rounded-sm border border-warning/40 bg-warning-surface px-4 py-3"
        >
          <span className="text-sm font-medium">
            <span className="tabular-nums">{count}</span> {title}
          </span>
          <span className="text-xs text-muted-foreground">{detail}</span>
          {link}
        </li>,
      );
    }
  };
  const open = "mt-1 w-fit text-xs font-medium text-primary hover:underline";
  const accounts = (search: AccountsSearch, text: string) => (
    <Link to="/admin/people/accounts" search={search} className={open}>
      {text}
    </Link>
  );

  const lockedCount = locked.data?.total ?? 0;
  card(
    lockedCount,
    plural(lockedCount, { one: "locked account", other: "locked accounts" }),
    t`Too many failed sign-ins. They wait for the lock to end, or for you to unlock them.`,
    accounts({ status: "locked" }, t`See the locked accounts`),
  );
  if (readsAll) {
    const unprotectedCount = unprotected.data?.total ?? 0;
    card(
      unprotectedCount,
      plural(unprotectedCount, {
        one: "administrator without a second factor",
        other: "administrators without a second factor",
      }),
      t`An administrator's password alone opens every account and setting of the instance.`,
      accounts(
        { status: "active", admin: "yes", mfa: "no" },
        t`See who they are`,
      ),
    );
    const pending = invitations.data?.invitations.length ?? 0;
    card(
      pending,
      plural(pending, {
        one: "invitation waiting",
        other: "invitations waiting",
      }),
      t`Sent to people who have not joined yet. Send one again, or withdraw it.`,
      <Link
        to="/admin/people/accounts"
        hash="invitations"
        className={open}
      >{t`See the invitations`}</Link>,
    );
    const queue = health.data?.queue;
    const failures =
      (queue?.failedJobs24h ?? 0) +
      (queue?.failedDeliveries24h ?? 0) +
      (queue?.failedRuns24h ?? 0);
    card(
      failures,
      plural(failures, {
        one: "failure in the last 24 hours",
        other: "failures in the last 24 hours",
      }),
      t`Background jobs, webhook deliveries, or automation runs that did not go through.`,
      <Link to="/admin/instance/support" className={open}>
        {t`See what failed`}
      </Link>,
    );
    // Failures have their card above, whatever their number.
    const openAlerts = (alerts.data?.alerts ?? []).filter(
      (alert) => alert.kind !== "failures",
    );
    const firstAlert = openAlerts[0];
    const alertCount = openAlerts.length;
    card(
      alertCount,
      plural(alertCount, { one: "alert is open", other: "alerts are open" }),
      firstAlert ? alertText(firstAlert) : "",
      <Link to="/admin/instance/health" className={open}>
        {t`See the alerts`}
      </Link>,
    );
    const ownerlessCount = ownerless.data?.count ?? 0;
    card(
      ownerlessCount,
      plural(ownerlessCount, {
        one: "base without an active owner",
        other: "bases without an active owner",
      }),
      t`Nobody can manage them: every owner's account is disabled, or there is none.`,
      <Link to="/admin/bases" className={open}>
        {t`See the bases`}
      </Link>,
    );
  }

  if (queries.some((query) => query.isLoading)) return <Spinner />;
  return cards.length > 0 ? (
    <ul className="grid gap-3 sm:grid-cols-2">{cards}</ul>
  ) : (
    <p className="flex items-center gap-2 rounded-sm border border-border px-4 py-3 text-sm">
      <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />
      {t`Nothing needs your attention.`}
    </p>
  );
}
