import { Button, Checkbox, Input, Label } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState, type SubmitEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useCatalog, useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { registerPasskey } from "../../lib/webauthn";
import { ConfirmDialog } from "../shell/dialogs";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function BackupCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  const { t } = useLingui();
  const copy = useCopy();
  return (
    <div className="rounded-lg border border-primary/40 bg-accent/40 p-4">
      <p className="text-sm font-medium">{t`Backup codes, shown only once.`}</p>
      <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => copy(codes.join("\n"))}
        >
          <Copy className="h-4 w-4" aria-hidden />
          {t`Copy`}
        </Button>
        <Button size="sm" onClick={onDone}>
          {t`I saved the codes`}
        </Button>
      </div>
    </div>
  );
}

export function AccountSettings({
  welcome = false,
}: {
  /** Just signed up: suggest a second factor first. */
  welcome?: boolean;
}) {
  const { t } = useLingui();
  const copy = useCopy();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const session = useSession();
  const tokens = useQuery(api.auth.tokens.queryOptions());
  const preferences = useQuery(api.notifications.preferences.queryOptions());
  const [secret, setSecret] = useState<{ secret: string; url: string } | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [tokenBases, setTokenBases] = useState<string[]>([]);
  const [tokenReadOnly, setTokenReadOnly] = useState(false);
  const catalog = useCatalog();
  const [newToken, setNewToken] = useState("");
  const [tokenDays, setTokenDays] = useState("");
  const instance = useQuery(api.auth.instance.queryOptions());
  const tokenMaxDays = instance.data?.tokenMaxDays ?? 365;
  const minLength = instance.data?.passwordMinLength ?? 12;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [erasePassword, setErasePassword] = useState("");
  const [confirmErase, setConfirmErase] = useState(false);
  const user = session.data;

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: api.session.current.queryKey(),
    });
  }

  if (!user) return null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-6">
      <h1 className="text-xl font-semibold">{t`Account settings`}</h1>
      {user.mfaRequired && !user.mfaEnrolled ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {t`Your organization asks for a second factor on this account: set one up below to go on.`}
        </p>
      ) : welcome ? (
        <p className="rounded-lg border border-primary/40 bg-accent/40 p-3 text-sm">
          {user.mfaForBases
            ? t`Welcome! Enable a second factor: it is required to create a base.`
            : t`Welcome! A second factor protects your account: you can enable one below.`}
        </p>
      ) : null}
      <Section title={t`Profile`}>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t`Display name`}</dt>
          <dd>{user.displayName}</dd>
          <dt className="text-muted-foreground">{t`Email`}</dt>
          <dd>{user.email}</dd>
        </dl>
      </Section>
      <Section title={t`Notifications`}>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={preferences.data?.notifyByEmail ?? false}
            disabled={!preferences.data}
            onChange={(event) => {
              const notifyByEmail = event.target.checked;
              void run(async () => {
                await trpc.notifications.setPreferences.mutate({
                  notifyByEmail,
                });
                await queryClient.invalidateQueries({
                  queryKey: api.notifications.preferences.queryKey(),
                });
              });
            }}
          />
          {t`Also send my notifications by email`}
        </label>
        <p className="text-xs text-muted-foreground">
          {t`Mentions, replies, assignments, and alerts. The email only holds the table name and a link.`}
        </p>
      </Section>
      {user.hasPassword ? (
        <Section
          title={t`Password`}
          description={t`At least ${{ minLength }} characters. Changing it signs you out everywhere else.`}
        >
          <form
            className="flex max-w-sm flex-col gap-2"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              void run(async () => {
                if (next !== again) {
                  toast.error(t`The two new passwords differ`);
                  return;
                }
                await trpc.auth.changePassword.mutate({
                  current,
                  password: next,
                });
                setCurrent("");
                setNext("");
                setAgain("");
                toast.success(t`Password changed. Your other sessions ended.`);
              });
            }}
          >
            <Label htmlFor="password-current">{t`Current password`}</Label>
            <Input
              id="password-current"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
            <Label htmlFor="password-new">{t`New password`}</Label>
            <Input
              id="password-new"
              type="password"
              autoComplete="new-password"
              required
              minLength={minLength}
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
            <Label htmlFor="password-again">{t`New password, again`}</Label>
            <Input
              id="password-again"
              type="password"
              autoComplete="new-password"
              required
              minLength={minLength}
              value={again}
              onChange={(event) => setAgain(event.target.value)}
            />
            <Button type="submit" className="self-start">
              {t`Change the password`}
            </Button>
          </form>
        </Section>
      ) : null}
      <Section
        title={t`Two-factor authentication`}
        description={t`A TOTP app or a passkey, asked at each sign-in after your password.`}
      >
        <p className="flex items-center gap-2 text-sm">
          <ShieldCheck
            className={
              user.mfaEnrolled
                ? "h-4 w-4 text-primary"
                : "h-4 w-4 text-muted-foreground"
            }
            aria-hidden
          />
          {user.mfaEnrolled ? t`Second factor enabled` : t`No second factor`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void run(async () => {
                const result = await trpc.auth.totp.begin.mutate();
                setSecret({ secret: result.secret, url: result.otpauthUrl });
              })
            }
          >
            {t`Enable TOTP`}
          </Button>
          <Button
            variant="outline"
            disabled={!window.isSecureContext}
            onClick={() =>
              void run(async () => {
                const codes = await registerPasskey();
                if (codes.length > 0) setBackupCodes(codes);
                toast.success(t`Passkey registered`);
                await refresh();
              })
            }
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            {t`Register a passkey`}
          </Button>
        </div>
        {window.isSecureContext ? null : (
          <p className="text-sm text-muted-foreground">
            {t`Browsers accept passkeys on an HTTPS address only: use TOTP, or open AnyGridDB over HTTPS.`}
          </p>
        )}
        {secret ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              void run(async () => {
                const result = await trpc.auth.totp.confirm.mutate({
                  secret: secret.secret,
                  code,
                });
                setBackupCodes(result.backupCodes);
                setSecret(null);
                setCode("");
                await refresh();
              });
            }}
          >
            <Label htmlFor="totp-secret">{t`Secret`}</Label>
            <Input
              id="totp-secret"
              readOnly
              value={secret.secret}
              className="font-mono"
            />
            <Label htmlFor="totp-url">{t`Authenticator URL`}</Label>
            <Input
              id="totp-url"
              readOnly
              value={secret.url}
              className="font-mono text-xs"
            />
            <Label htmlFor="totp-code">{t`Code`}</Label>
            <Input
              id="totp-code"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit">{t`Confirm TOTP`}</Button>
          </form>
        ) : null}
        {backupCodes.length > 0 ? (
          <BackupCodes codes={backupCodes} onDone={() => setBackupCodes([])} />
        ) : null}
      </Section>
      <Section
        title={t`API tokens`}
        description={t`A token acts with your rights. It is shown once and lives the days you choose, ${{ max: tokenMaxDays }} at most on this instance.`}
      >
        {user.canCreateTokens ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const created = await trpc.auth.createToken.mutate({
                  name: tokenName,
                  baseIds: tokenBases.length > 0 ? tokenBases : undefined,
                  readOnly: tokenReadOnly,
                  days: tokenDays ? Number(tokenDays) : undefined,
                });
                setNewToken(created.token);
                setTokenName("");
                setTokenDays("");
                setTokenBases([]);
                setTokenReadOnly(false);
                await queryClient.invalidateQueries({
                  queryKey: api.auth.tokens.queryKey(),
                });
              });
            }}
          >
            <Input
              aria-label={t`Token name`}
              placeholder={t`Token name`}
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
            />
            <Input
              type="number"
              className="w-28"
              aria-label={t`Days`}
              placeholder={t`${{ days: Math.min(30, tokenMaxDays) }} days`}
              min={1}
              max={tokenMaxDays}
              value={tokenDays}
              onChange={(event) => setTokenDays(event.target.value)}
            />
            <Button type="submit" disabled={!tokenName.trim()}>
              {t`Create`}
            </Button>
            <div className="flex w-full flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{t`Reachable bases`} :</span>
              {(catalog.data ?? []).length === 0 ? (
                <span>{t`All bases`}</span>
              ) : null}
              {(catalog.data ?? []).map((base) => (
                <label key={base.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={tokenBases.includes(base.id)}
                    onChange={(event) =>
                      setTokenBases((current) =>
                        event.target.checked
                          ? [...current, base.id]
                          : current.filter((id) => id !== base.id),
                      )
                    }
                  />
                  {base.name}
                </label>
              ))}
              <label className="ml-auto flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={tokenReadOnly}
                  onChange={(event) => setTokenReadOnly(event.target.checked)}
                />
                {t`Read only`}
              </label>
            </div>
          </form>
        ) : (
          <p
            role="status"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
          >
            {t`On this instance, only administrators create API tokens. The tokens below stop working while it is so.`}
          </p>
        )}
        {newToken ? (
          <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-accent/40 p-2">
            <code className="flex-1 truncate text-xs">{newToken}</code>
            <Button size="xs" variant="outline" onClick={() => copy(newToken)}>
              {t`Copy`}
            </Button>
          </div>
        ) : null}
        <ul className="divide-y divide-border text-sm">
          {(tokens.data?.tokens ?? []).map((token) => (
            <li
              key={token.id}
              className="flex items-center justify-between py-2"
            >
              <span>
                {token.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {t`expires on ${{ date: token.expiresAt.slice(0, 10) }}`}
                  {" · "}
                  {token.baseIds
                    ? (catalog.data ?? [])
                        .filter((base) => token.baseIds?.includes(base.id))
                        .map((base) => base.name)
                        .join(", ") || "—"
                    : t`All bases`}
                  {token.readOnly ? ` · ${t`Read only`}` : ""}
                  {" · "}
                  {token.lastUsedAt
                    ? t`last used ${{ date: token.lastUsedAt.slice(0, 10) }}`
                    : t`never used`}
                </span>
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void run(async () => {
                    await trpc.auth.revokeToken.mutate({ tokenId: token.id });
                    await queryClient.invalidateQueries({
                      queryKey: api.auth.tokens.queryKey(),
                    });
                  })
                }
              >
                {t`Revoke`}
              </Button>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title={t`Delete account`}
        description={t`Refused while an audit row, a signature, or a role refers to you.`}
      >
        <div className="flex gap-2">
          <Input
            type="password"
            aria-label={t`Password`}
            placeholder={t`Password`}
            value={erasePassword}
            onChange={(event) => setErasePassword(event.target.value)}
          />
          <Button
            variant="danger"
            disabled={erasePassword.length < 12}
            onClick={() => setConfirmErase(true)}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            {t`Delete`}
          </Button>
        </div>
      </Section>
      <ConfirmDialog
        open={confirmErase}
        onOpenChange={setConfirmErase}
        danger
        title={t`Permanently delete your account?`}
        description={t`This cannot be undone.`}
        confirmLabel={t`Delete`}
        onConfirm={() =>
          run(async () => {
            await trpc.auth.erase.mutate({ password: erasePassword });
            queryClient.clear();
            await navigate({ to: "/login", replace: true });
          })
        }
      />
    </div>
  );
}
