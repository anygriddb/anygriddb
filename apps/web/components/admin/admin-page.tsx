import {
  Avatar,
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from "@anygriddb/ui";
import type { InstanceSettingsPatch } from "@anygriddb/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  Database,
  Download,
  KeyRound,
  LifeBuoy,
  LockKeyhole,
  MonitorSmartphone,
  MoreHorizontal,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { ScimTab } from "./scim-tab";
import { SecurityTab } from "./security-tab";
import { SessionsTab } from "./sessions-tab";
import { SignInTrail } from "./sign-in-trail";
import { SourcesTab } from "./sources-tab";
import { SupportTab } from "./support-tab";
import { datedName, downloadCsv } from "../../lib/download";
import { formatBytes } from "../../lib/format";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { known } from "../../lib/known-text";
import { useCopy } from "../../lib/clipboard";

type Tab =
  | "users"
  | "sessions"
  | "provisioning"
  | "sources"
  | "audit"
  | "health"
  | "support"
  | "security"
  | "settings";

/** What an administrator may do to another account (ADRs 0042, 0043). */
type AccountAction = "sessions" | "factors" | "tokens" | "unlock" | "reset";

function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function UsersTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const session = useSession();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [confirm, setConfirm] = useState<{
    id: string;
    name: string;
    disable: boolean;
  } | null>(null);
  const [act, setAct] = useState<{
    id: string;
    name: string;
    action: AccountAction;
  } | null>(null);
  // A reset link to pass on, when the instance sends no email.
  const [handed, setHanded] = useState<{ name: string; link: string } | null>(
    null,
  );
  const copy = useCopy();
  const options = api.admin.users.queryOptions({
    search: search || undefined,
    offset,
    limit: 50,
  });
  const list = useQuery(options);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: api.admin.users.queryKey() });
  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  const total = list.data?.total ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <Input
        aria-label={t`Search accounts`}
        placeholder={t`Name or email`}
        className="max-w-xs"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setOffset(0);
        }}
      />
      {list.isLoading ? <Spinner /> : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs">
            <tr>
              <th className="px-3 py-2">{t`Account`}</th>
              <th className="px-3 py-2">{t`Created`}</th>
              <th className="px-3 py-2">{t`Last sign-in`}</th>
              <th className="px-3 py-2">{t`Second factor`}</th>
              <th className="px-3 py-2">{t`Bases`}</th>
              <th className="px-3 py-2">{t`Administrator`}</th>
              <th className="px-3 py-2">{t`Status`}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{t`Actions`}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.users ?? []).map((user) => {
              const self = user.id === session.data?.id;
              return (
                <tr key={user.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Avatar name={user.displayName} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {user.displayName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.email}
                          {user.provisioned ? ` · ${t`SCIM`}` : null}
                          {user.deprovisioned
                            ? ` · ${t`removed by the identity provider`}`
                            : null}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">{date(user.createdAt)}</td>
                  <td className="px-3 py-2 text-xs">{date(user.lastSeen)}</td>
                  <td className="px-3 py-2 text-xs">
                    {user.mfa ? t`Yes` : t`No`}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">
                    {user.bases}
                  </td>
                  <td className="px-3 py-2">
                    <Checkbox
                      aria-label={t`Administrator`}
                      checked={user.isAdmin}
                      disabled={self}
                      onChange={(event) =>
                        void run(() =>
                          trpc.admin.setAdmin.mutate({
                            userId: user.id,
                            admin: event.target.checked,
                          }),
                        )
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    {self ? (
                      <span className="text-xs text-muted-foreground">
                        {t`You`}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant={user.disabledAt ? "outline" : "ghost"}
                        onClick={() =>
                          setConfirm({
                            id: user.id,
                            name: user.displayName,
                            disable: !user.disabledAt,
                          })
                        }
                      >
                        {user.disabledAt ? t`Enable` : t`Disable`}
                      </Button>
                    )}
                    {user.disabledAt ? (
                      <p className="text-xs text-red-600">
                        {user.disabledReason === "inactive"
                          ? t`Disabled on ${{ date: date(user.disabledAt) }}, unused`
                          : t`Disabled on ${{ date: date(user.disabledAt) }}`}
                      </p>
                    ) : null}
                    {user.lock ? (
                      <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                        <LockKeyhole
                          className="mt-0.5 h-3 w-3 shrink-0"
                          aria-hidden
                        />
                        {user.lock.until
                          ? t`Locked until ${{ date: date(user.lock.until) }}`
                          : t`Locked until unlocked`}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {self ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={t`Actions for ${{ name: user.displayName }}`}
                          className="rounded p-1 hover:bg-muted"
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {user.lock ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                setAct({
                                  id: user.id,
                                  name: user.displayName,
                                  action: "unlock",
                                })
                              }
                            >
                              {t`Unlock`}
                            </DropdownMenuItem>
                          ) : null}
                          {user.hasPassword ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                setAct({
                                  id: user.id,
                                  name: user.displayName,
                                  action: "reset",
                                })
                              }
                            >
                              {t`Send a password reset link`}
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            onSelect={() =>
                              setAct({
                                id: user.id,
                                name: user.displayName,
                                action: "sessions",
                              })
                            }
                          >
                            {t`Sign out everywhere`}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              setAct({
                                id: user.id,
                                name: user.displayName,
                                action: "factors",
                              })
                            }
                          >
                            {t`Remove their second factors`}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              setAct({
                                id: user.id,
                                name: user.displayName,
                                action: "tokens",
                              })
                            }
                          >
                            {t`Revoke their API tokens`}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {t`${{ from: total === 0 ? 0 : offset + 1 }}–${{ to: Math.min(offset + 50, total) }} of ${total}`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          {t`Previous`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={offset + 50 >= total}
          onClick={() => setOffset(offset + 50)}
        >
          {t`Next`}
        </Button>
      </div>
      {confirm ? (
        <ConfirmDialog
          open
          danger={confirm.disable}
          onOpenChange={(open) => !open && setConfirm(null)}
          title={
            confirm.disable
              ? t`Disable ${{ name: confirm.name }}'s account?`
              : t`Enable ${{ name: confirm.name }}'s account again?`
          }
          description={
            confirm.disable
              ? t`Their sessions end and their API tokens stop working. Their data and audit history are kept.`
              : t`The person will be able to sign in again.`
          }
          confirmLabel={confirm.disable ? t`Disable` : t`Enable`}
          onConfirm={() =>
            run(() =>
              trpc.admin.setDisabled.mutate({
                userId: confirm.id,
                disabled: confirm.disable,
              }),
            )
          }
        />
      ) : null}
      {act ? (
        <ConfirmDialog
          open
          danger={act.action !== "unlock" && act.action !== "reset"}
          onOpenChange={(open) => !open && setAct(null)}
          title={
            {
              sessions: t`Sign ${{ name: act.name }} out everywhere?`,
              factors: t`Remove ${{ name: act.name }}'s second factors?`,
              tokens: t`Revoke ${{ name: act.name }}'s API tokens?`,
              unlock: t`Unlock ${{ name: act.name }}'s account?`,
              reset: t`Send ${{ name: act.name }} a password reset link?`,
            }[act.action]
          }
          description={
            {
              sessions: t`Every session of this account ends now. The person can sign in again.`,
              factors: t`Their authenticator, passkeys, and backup codes are removed, and their sessions end. They sign in with their password and set up a second factor again. For a lost phone or key.`,
              tokens: t`Scripts and tools using these tokens stop working at once.`,
              unlock: t`The person can sign in again now, and their count of failed attempts starts over.`,
              reset: t`The link sets a new password once, within a day; their second factors stay. With email set up, it goes to their address and you never see it. Otherwise you get it to pass on: only to them, as it opens their account.`,
            }[act.action]
          }
          confirmLabel={
            {
              sessions: t`Sign out`,
              factors: t`Remove`,
              tokens: t`Revoke`,
              unlock: t`Unlock`,
              reset: t`Send`,
            }[act.action]
          }
          onConfirm={() =>
            run(async () => {
              const userId = act.id;
              if (act.action === "sessions") {
                await trpc.admin.endUserSessions.mutate({ userId });
              } else if (act.action === "factors") {
                await trpc.admin.clearFactors.mutate({ userId });
              } else if (act.action === "unlock") {
                await trpc.admin.unlock.mutate({ userId });
              } else if (act.action === "reset") {
                const result = await trpc.admin.sendPasswordReset.mutate({
                  userId,
                });
                if (result.sent) {
                  toast.success(t`Link sent to ${{ to: result.to }}`);
                } else {
                  setHanded({ name: act.name, link: result.link });
                }
                return;
              } else {
                await trpc.admin.revokeTokens.mutate({ userId });
              }
              toast.success(t`Done`);
            })
          }
        />
      ) : null}
      {handed ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setHanded(null)}
          title={t`Reset link for ${{ name: handed.name }}`}
          description={t`Email is not set up, so pass this link on yourself, to this person only: it lets whoever has it choose the account's password, once, within a day.`}
          confirmLabel={t`Copy and close`}
          onConfirm={() => copy(handed.link, t`Link copied`)}
        >
          <code className="block rounded bg-muted px-2 py-1 font-mono text-xs break-all">
            {handed.link}
          </code>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const ACTIONS = [
  "insert",
  "update",
  "delete",
  "submit",
  "lock",
  "unlock",
  "sign",
  "catalog",
] as const;

/** The two trails: changes to data and structure, and sign-ins. */
function AuditTab() {
  const { t } = useLingui();
  const [trail, setTrail] = useState<"changes" | "sign-ins">("changes");
  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-label={t`Trail`}
        className="flex w-fit gap-1 rounded-lg border border-border p-0.5"
      >
        {(
          [
            ["changes", t`Changes`],
            ["sign-ins", t`Sign-ins`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={trail === value}
            onClick={() => setTrail(value)}
            className={cn(
              "rounded-md px-3 py-1 text-sm",
              trail === value
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {trail === "changes" ? <ChangesTrail /> : <SignInTrail />}
    </div>
  );
}

function ChangesTrail() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const [action, setAction] = useState<(typeof ACTIONS)[number] | "">("");
  const [source, setSource] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const log = useQuery(
    api.admin.audit.queryOptions({
      action: action || undefined,
      source: source || undefined,
      before,
      limit: 50,
    }),
  );
  const actionLabel = (value: string) =>
    ({
      insert: t`Creation`,
      update: t`Edit`,
      delete: t`Delete`,
      submit: t`Submission`,
      lock: t`Lock`,
      unlock: t`Unlock`,
      sign: t`Signature`,
      catalog: t`Structure`,
    })[value] ?? value;
  async function exportCsv() {
    try {
      const file = await trpc.admin.exportAudit.mutate({
        action: action || undefined,
        source: source || undefined,
      });
      downloadCsv(datedName("anygriddb-audit", "csv"), file.csv);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-action">{t`Action`}</Label>
          <Select
            id="audit-action"
            className="w-44"
            value={action}
            onChange={(event) => {
              setAction(event.target.value as typeof action);
              setCursors([]);
            }}
          >
            <option value="">{t`All`}</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-source">{t`Source`}</Label>
          <Input
            id="audit-source"
            className="w-44"
            placeholder="web, api, import, automation…"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setCursors([]);
            }}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => void exportCsv()}
        >
          <Download className="h-4 w-4" aria-hidden />
          {t`Export as CSV`}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t`The log shows who changed which fields. Values stay in each row's history, behind the table's access rights.`}
      </p>
      {log.isLoading ? <Spinner /> : null}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted text-left">
            <tr>
              <th className="px-2 py-1.5">{t`Date`}</th>
              <th className="px-2 py-1.5">{t`Author`}</th>
              <th className="px-2 py-1.5">{t`Table`}</th>
              <th className="px-2 py-1.5">{t`Action`}</th>
              <th className="px-2 py-1.5">{t`Fields`}</th>
              <th className="px-2 py-1.5">{t`Reason`}</th>
              <th className="px-2 py-1.5">{t`Source`}</th>
            </tr>
          </thead>
          <tbody>
            {(log.data?.events ?? []).map((event) => (
              <tr key={event.id} className="border-t border-border align-top">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {date(event.occurredAt)}
                </td>
                <td className="px-2 py-1.5">{event.userName ?? "—"}</td>
                <td className="px-2 py-1.5">
                  {event.tableName
                    ? `${event.baseName ?? ""} / ${event.tableName}`
                    : "—"}
                  {event.recordId ? (
                    <span className="block font-mono text-[10px] text-muted-foreground">
                      {event.recordId.slice(0, 8)}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5">{actionLabel(event.action)}</td>
                <td className="px-2 py-1.5">
                  {event.fields.join(", ") || "—"}
                </td>
                <td className="px-2 py-1.5">{event.reason ?? "—"}</td>
                <td className="px-2 py-1.5">{event.source ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={cursors.length === 0}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          {t`Newer`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!log.data?.next}
          onClick={() =>
            log.data?.next &&
            setCursors((current) => [...current, log.data.next as string])
          }
        >
          {t`Older`}
        </Button>
      </div>
    </div>
  );
}

function HealthTab() {
  const { t } = useLingui();
  const api = useTRPC();
  const health = useQuery({
    ...api.admin.health.queryOptions(),
    refetchInterval: 30_000,
  });
  const data = health.data;
  const checks = data
    ? ([
        [t`Database`, data.checks.database],
        [t`Realtime`, data.checks.realtime],
        [t`File storage`, data.checks.storage],
      ] as const)
    : [];
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
            className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm"
          >
            {check.ok ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden />
            ) : (
              <XCircle className="h-5 w-5 text-red-600" aria-hidden />
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
      <TlsCard />
      {data ? (
        <dl className="grid grid-cols-[16rem_1fr] gap-y-1 text-sm">
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
    <section className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
      <h2 className="flex items-center gap-2 font-medium">
        <ShieldCheck className="h-4 w-4 text-green-600" aria-hidden />
        {t`Encrypted connection (HTTPS)`}
      </h2>
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
    </section>
  );
}

function SettingsTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.settings.queryOptions());
  const [banner, setBanner] = useState<string | null>(null);
  const [domains, setDomains] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<boolean | null>(null);
  async function save(patch: InstanceSettingsPatch) {
    try {
      await trpc.admin.updateSettings.mutate(patch);
      await Promise.all(
        [api.admin.settings, api.auth.instance].map((procedure) =>
          queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
        ),
      );
      toast.success(t`Settings saved`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  if (!settings.data) return <Spinner />;
  const bannerText = banner ?? settings.data.banner ?? "";
  const savedDomains = settings.data.signupDomains.join(", ");
  const domainsText = domains ?? savedDomains;
  return (
    <div className="flex max-w-lg flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-maintenance">{t`Maintenance`}</Label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            id="setting-maintenance"
            checked={settings.data.maintenance}
            onChange={(event) => setMaintenance(event.target.checked)}
          />
          {t`Only administrators can sign in and work`}
        </label>
        <p className="text-xs text-muted-foreground">
          {t`For an upgrade or a restore. Turning it on signs everyone else out; their API tokens stop working until it is off.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-banner">{t`Announcement`}</Label>
        <Textarea
          id="setting-banner"
          rows={2}
          maxLength={500}
          placeholder={t`Shown at the top of the app to everyone signed in`}
          value={bannerText}
          onChange={(event) => setBanner(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={bannerText.trim() === (settings.data.banner ?? "")}
            onClick={() =>
              void save({ banner: bannerText.trim() || null }).then(() =>
                setBanner(null),
              )
            }
          >
            {t`Publish`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!settings.data.banner}
            onClick={() =>
              void save({ banner: null }).then(() => setBanner(null))
            }
          >
            {t`Remove`}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-signup">{t`Sign-ups`}</Label>
        <Select
          id="setting-signup"
          value={settings.data.signup}
          onChange={(event) =>
            void save({
              signup: event.target.value as "open" | "invite" | "closed",
            })
          }
        >
          <option value="open">{t`Open to anyone`}</option>
          <option value="invite">{t`By invitation to a base`}</option>
          <option value="closed">{t`Closed`}</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t`SSO sign-in follows the same rule for new accounts. Existing accounts are not affected.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-domains">{t`Sign-up domains`}</Label>
        <Input
          id="setting-domains"
          placeholder="example.org, example.com"
          value={domainsText}
          onChange={(event) => setDomains(event.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={domains === null || domainsText === savedDomains}
            onClick={() =>
              void save({
                signupDomains: domainsText
                  .split(/[\s,;]+/)
                  .map((domain) => domain.trim())
                  .filter(Boolean),
              }).then(() => setDomains(null))
            }
          >
            {t`Save`}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t`Only addresses of these domains can create an account on their own, by sign-up or SSO. Empty: any address. An owner's invitation still lets anyone in.`}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="setting-locale">{t`Default language`}</Label>
        <Select
          id="setting-locale"
          value={settings.data.defaultLocale}
          onChange={(event) =>
            void save({ defaultLocale: event.target.value as "fr" | "en" })
          }
        >
          <option value="fr">Français</option>
          <option value="en">English</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t`Used until a person picks their own language.`}
        </p>
      </div>
      {maintenance !== null ? (
        <ConfirmDialog
          open
          danger={maintenance}
          onOpenChange={(open) => !open && setMaintenance(null)}
          title={
            maintenance ? t`Turn maintenance on?` : t`Turn maintenance off?`
          }
          description={
            maintenance
              ? t`Everyone but administrators is signed out now, and cannot sign in until you turn it off.`
              : t`Everyone can sign in again.`
          }
          confirmLabel={maintenance ? t`Turn on` : t`Turn off`}
          onConfirm={() => save({ maintenance })}
        />
      ) : null}
    </div>
  );
}

/**
 * Instance administration: accounts and their sessions, provisioning,
 * sources, the audit trails, health, support, and settings.
 */
export function AdminPage() {
  const { t } = useLingui();
  const session = useSession();
  const [tab, setTab] = useState<Tab>("users");
  if (!session.data) return null;
  if (!session.data.isAdmin) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`This page is for instance administrators.`}
      </p>
    );
  }
  const tabs: Array<[Tab, string, typeof Users]> = [
    ["users", t`Accounts`, Users],
    ["sessions", t`Sessions`, MonitorSmartphone],
    ["provisioning", t`Provisioning`, KeyRound],
    ["sources", t`Sources`, Database],
    ["audit", t`Audit log`, ScrollText],
    ["health", t`Health`, Activity],
    ["support", t`Support`, LifeBuoy],
    ["security", t`Security`, LockKeyhole],
    ["settings", t`Settings`, Settings2],
  ];
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">{t`Administration`}</h1>
      <div role="tablist" className="flex gap-1 border-b border-border">
        {tabs.map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              tab === value
                ? "border-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "users" ? <UsersTab /> : null}
        {tab === "sessions" ? <SessionsTab /> : null}
        {tab === "provisioning" ? <ScimTab /> : null}
        {tab === "sources" ? <SourcesTab /> : null}
        {tab === "audit" ? <AuditTab /> : null}
        {tab === "health" ? <HealthTab /> : null}
        {tab === "support" ? <SupportTab /> : null}
        {tab === "security" ? <SecurityTab /> : null}
        {tab === "settings" ? <SettingsTab /> : null}
      </div>
    </div>
  );
}
