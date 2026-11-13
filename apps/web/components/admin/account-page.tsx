import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Spinner,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, LockKeyhole, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useSession } from "../../lib/session";
import { useTRPC } from "../../lib/trpc";
import { LoadFailed } from "../shell/load-failed";
import {
  ACCOUNT_ACTIONS,
  useAccountActions,
  type AccountAction,
  type AccountTarget,
} from "./account-actions";
import { AccountBases } from "./account-bases";
import { useAuthLabels } from "./auth-labels";

/** The everyday actions, in view at the top of the page (ROADMAP #13). */
const IN_VIEW: readonly AccountAction[] = [
  "edit",
  "reset",
  "disable",
  "delete",
];

function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * One account in Administration (ROADMAP #19): who it is, where it comes
 * from and how it signs in, its bases and roles (and the group that gives
 * each), sessions, API tokens, and last sign-ins, with every action in
 * view or in its menu, as in the accounts list.
 */
export function AccountAdminPage({ userId }: { userId: string }) {
  const { t } = useLingui();
  const api = useTRPC();
  const session = useSession();
  const navigate = useNavigate();
  const labels = useAuthLabels();
  const detail = useQuery(api.admin.account.queryOptions({ userId }));
  const actions = useAccountActions({
    mails: detail.data?.smtpReady ?? false,
    onChanged: (action) => {
      if (action === "delete") {
        void navigate({ to: "/admin/people/accounts" });
      }
    },
  });
  const back = (
    <Link
      to="/admin/people/accounts"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {t`Accounts`}
    </Link>
  );
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <LoadFailed
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }
  if (!detail.data) return <Spinner />;
  const account = detail.data;
  const self = account.id === session.data?.id;
  const target: AccountTarget = {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    isAdmin: account.isAdmin,
    disabled: account.disabledAt !== null,
    locked: account.lock !== null,
    hasPassword: account.hasPassword,
    signOn: account.identities.length > 0,
    managed: account.provisioned && !account.deprovisioned,
  };
  const origin =
    account.origin === "scim"
      ? account.deprovisioned
        ? t`Provisioned by the identity provider (SCIM), then removed by it`
        : t`Managed by your identity provider (SCIM)`
      : account.origin === "sso"
        ? t`Bound to single sign-on`
        : t`Made here`;
  const signsIn = account.hasPassword
    ? t`With a password`
    : account.origin === "local"
      ? t`No password yet: the first link sets one`
      : t`Through the identity provider only`;
  return (
    <div className="flex flex-col gap-5">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {account.displayName}
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {account.email}
          </p>
          <p className="mt-1 flex flex-wrap gap-1 text-xs">
            {account.isAdmin ? <Badge>{t`Administrator`}</Badge> : null}
            {account.isSupport ? <Badge>{t`Support`}</Badge> : null}
            {self ? <Badge>{t`You`}</Badge> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {IN_VIEW.map((action) => actions.button(action, target))}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t`More actions`}
              className="rounded p-1 hover:bg-muted"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {ACCOUNT_ACTIONS.map((action) =>
                actions.menuItem(action, target),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Facts>
        <Fact label={t`Status`}>
          {account.disabledAt ? (
            <span className="text-danger">
              {account.disabledReason === "inactive"
                ? t`Disabled on ${{ date: date(account.disabledAt) }}, unused`
                : t`Disabled on ${{ date: date(account.disabledAt) }}`}
            </span>
          ) : (
            t`Active`
          )}
          {account.lock ? (
            <span className="mt-0.5 flex items-start gap-1 text-warning">
              <LockKeyhole className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {account.lock.until
                ? t`Locked until ${{ date: date(account.lock.until) }}`
                : t`Locked until unlocked`}
            </span>
          ) : null}
        </Fact>
        <Fact label={t`Origin`}>{origin}</Fact>
        <Fact label={t`Signs in`}>{signsIn}</Fact>
        <Fact label={t`Second factor`}>
          {account.factors.length > 0
            ? account.factors.map(labels.method).join(", ")
            : t`None`}
        </Fact>
        <Fact label={t`Created`}>{date(account.createdAt)}</Fact>
      </Facts>

      <AccountBases
        userId={account.id}
        name={account.displayName}
        bases={account.bases}
        canChange={session.data?.isAdmin === true}
      />

      {account.identities.length > 0 ? (
        <Part title={t`Single sign-on`} empty={null}>
          <ul className="text-xs text-muted-foreground">
            {account.identities.map((identity) => (
              <li key={`${identity.provider}:${identity.issuer}`}>
                {identity.provider.toUpperCase()} · {identity.issuer} ·{" "}
                {t`last seen ${{ date: date(identity.lastSeenAt) }}`}
              </li>
            ))}
          </ul>
        </Part>
      ) : null}

      <Part
        title={t`Sessions`}
        empty={
          account.sessions.length === 0 ? t`No session open right now.` : null
        }
      >
        <ul className="text-xs text-muted-foreground">
          {account.sessions.map((row) => (
            <li key={row.id}>
              {t`Opened ${{ opened: date(row.createdAt) }}, ends ${{ ends: date(row.expiresAt) }}`}
            </li>
          ))}
        </ul>
      </Part>

      <Part
        title={t`API tokens`}
        empty={account.tokens.length === 0 ? t`No API token.` : null}
      >
        <ul className="divide-y divide-border rounded-sm border border-border text-xs">
          {account.tokens.map((token) => (
            <li
              key={token.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <span className="truncate">
                {token.name}
                {token.readOnly ? ` · ${t`read only`}` : ""}
              </span>
              <span className="text-muted-foreground">
                {token.lastUsedAt
                  ? t`Last used ${{ date: date(token.lastUsedAt) }}`
                  : t`Never used`}
              </span>
            </li>
          ))}
        </ul>
      </Part>

      <Part
        title={t`Last sign-in events`}
        empty={account.signIns.length === 0 ? t`No sign-in event yet.` : null}
      >
        <ul className="text-xs text-muted-foreground">
          {account.signIns.map((event) => (
            <li key={event.id}>
              {date(event.occurredAt)} · {labels.action(event.action)}
              {event.method ? ` · ${labels.method(event.method)}` : ""}
              {event.ip ? ` · ${event.ip}` : ""}
            </li>
          ))}
        </ul>
        <Link
          to="/admin/trails/sign-ins"
          className="mt-1 w-fit text-xs text-primary hover:underline"
        >
          {t`The whole sign-in trail`}
        </Link>
      </Part>

      {actions.dialogs}
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
      {children}
    </span>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-sm border border-border p-3 text-sm sm:grid-cols-2">
      {children}
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="flex flex-col">{children}</dd>
    </div>
  );
}

/** A part of the page: its title, then its list or what stands in for it. */
function Part({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {empty === null ? (
        children
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}
