import { Button, Input, Label } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { signInWithPasskey } from "../../lib/webauthn";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { AuthFrame } from "./auth-frame";

/**
 * A path of this app to come back to. Anything else goes home: another
 * site (`//host`, or `/\host`, which browsers read as `//host`), text with
 * control characters, or the sign-in pages themselves, which would nest
 * `/login?next=/login?next=…` without end.
 */
export function safeNext(value: string | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\p{Cc}]/u.test(value)
  ) {
    return "/";
  }
  const path = value.split(/[?#]/, 1)[0];
  return path === "/login" || path === "/signup" ? "/" : value;
}

/**
 * The invitation a sign-up comes from, when the person followed its link:
 * that link reached the address, which needs no other proof (ADR 0058).
 */
export function invitationToken(next: string): string | undefined {
  return /^\/invite\/([A-Za-z0-9_-]{32,64})$/.exec(next)?.[1];
}

/**
 * Whether a sign-up from this page would be refused for want of email:
 * without it, a sign-up of one's own cannot prove its address, and only an
 * invitation's link brings someone in (ADR 0058). The page says so at once
 * instead of offering a form that cannot succeed.
 */
export function signupNeedsMail(
  instanceNeedsMail: boolean | undefined,
  next: string,
): boolean {
  return instanceNeedsMail === true && invitationToken(next) === undefined;
}

export function AuthPage({
  mode,
  next: requested,
  secondStep = false,
}: {
  mode: "login" | "signup";
  /** The `next` search parameter, unchecked. */
  next?: string;
  /** Back from single sign-on, with AnyGridDB's own second step to do. */
  secondStep?: boolean;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const next = safeNext(requested);
  const queryClient = useQueryClient();
  const api = useTRPC();
  const session = useSession();
  const providers = useQuery(api.session.providers.queryOptions());
  const instance = useQuery(api.auth.instance.queryOptions());
  const policy = instance.data?.signup ?? "open";
  const ssoOnly = instance.data?.ssoOnly === true;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [methods, setMethods] = useState<Array<"totp" | "webauthn">>([]);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  /** Recovery path: hide TOTP/passkey and show the backup-code form alone. */
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  /** The address a sign-up's link was mailed to (ADR 0058). */
  const [awaiting, setAwaiting] = useState("");
  const finishing = useRef(false);
  const minLength = instance.data?.passwordMinLength ?? 12;
  const needsMail =
    mode === "signup" && signupNeedsMail(instance.data?.signupNeedsMail, next);

  // The second step a single sign-on left to do (ADR 0043).
  useEffect(() => {
    if (!secondStep) return;
    void trpc.auth.challenge.query().then((challenge) => {
      if (challenge && challenge.methods.length > 0) {
        setMethods(challenge.methods);
      }
    });
  }, [secondStep]);

  useEffect(() => {
    if (session.data && !finishing.current) {
      void navigate({ href: next, replace: true });
    }
  }, [session.data, next, navigate]);

  async function finish() {
    finishing.current = true;
    await queryClient.invalidateQueries();
    // A new account starts with the first-run page: secure it, bring data.
    await (mode === "signup" && next === "/"
      ? navigate({ to: "/welcome", replace: true })
      : navigate({ href: next, replace: true }));
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    void run(async () => {
      if (mode === "signup") {
        const invitation = invitationToken(next);
        const result = await trpc.auth.signup.mutate({
          email,
          password,
          displayName,
          ...(invitation ? { invitation } : {}),
        });
        if (result.status === "verify") {
          setAwaiting(email);
          return;
        }
        await finish();
        return;
      }
      const result = await trpc.auth.login.mutate({ email, password });
      if (result.status === "mfa") {
        setMethods(result.methods);
        return;
      }
      await finish();
    });
  }

  return (
    <AuthFrame>
      {awaiting ? (
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">{t`Check your email`}</h1>
          <p role="status" className="text-sm">
            {t`A message is on its way to ${awaiting}. Open the link it holds to finish: it works for a day.`}
          </p>
          <Link className="text-sm text-primary hover:underline" to="/login">
            {t`Back to sign-in`}
          </Link>
        </div>
      ) : forgot ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await trpc.auth.requestPasswordReset.mutate({ email });
              setSent(true);
            });
          }}
        >
          <h1 className="text-2xl font-semibold">{t`Forgot your password?`}</h1>
          {sent ? (
            <p role="status" className="text-sm">
              {t`If an account uses this address, a link to choose a new password is on its way. It works once, for an hour.`}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t`Enter your address: we send a link to choose a new password. Your second factor stays as it is.`}
              </p>
              <Label htmlFor="forgot-email">{t`Email`}</Label>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button type="submit" disabled={busy}>
                {t`Send the link`}
              </Button>
            </>
          )}
          <button
            type="button"
            className="text-center text-sm text-primary hover:underline"
            onClick={() => {
              setForgot(false);
              setSent(false);
              setError("");
            }}
          >
            {t`Back to sign-in`}
          </button>
        </form>
      ) : methods.length > 0 ? (
        useBackup ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await trpc.auth.backup.verify.mutate({ code: backup });
                await finish();
              });
            }}
          >
            <h1 className="text-2xl font-semibold">{t`Backup code`}</h1>
            <p className="text-sm text-muted-foreground">
              {t`Use one of the one-time codes you saved when you set up your second factor.`}
            </p>
            <Label htmlFor="backup">{t`Backup code`}</Label>
            <Input
              id="backup"
              autoComplete="off"
              autoFocus
              value={backup}
              onChange={(event) => setBackup(event.target.value)}
            />
            <Button type="submit" disabled={busy}>
              {t`Use the backup code`}
            </Button>
            <button
              type="button"
              className="text-center text-sm text-primary hover:underline"
              onClick={() => {
                setUseBackup(false);
                setBackup("");
                setError("");
              }}
            >
              {t`Back`}
            </button>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold">{t`Second factor`}</h1>
            {methods.includes("totp") ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await trpc.auth.totp.verify.mutate({ code });
                    await finish();
                  });
                }}
              >
                <Label htmlFor="totp">{t`Authenticator code`}</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
                <Button type="submit" disabled={busy}>
                  {t`Verify`}
                </Button>
              </form>
            ) : null}
            {methods.includes("webauthn") ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await signInWithPasskey();
                    await finish();
                  })
                }
              >
                <KeyRound className="h-4 w-4" aria-hidden />
                {t`Use a passkey`}
              </Button>
            ) : null}
            <button
              type="button"
              className="text-center text-sm text-primary hover:underline"
              onClick={() => {
                setUseBackup(true);
                setCode("");
                setError("");
              }}
            >
              {t`Lost your authenticator? Use a backup code`}
            </button>
          </div>
        )
      ) : (
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <h1 className="text-2xl font-semibold">
            {mode === "login" ? t`Sign in` : t`Create an account`}
          </h1>
          {instance.data?.maintenance ? (
            <p
              role="status"
              className="rounded-md border border-warning/40 bg-warning-surface p-2 text-xs"
            >
              {t`The instance is under maintenance: only administrators can sign in for now.`}
              {instance.data.banner ? (
                <span className="mt-1 block whitespace-pre-line">
                  {instance.data.banner}
                </span>
              ) : null}
            </p>
          ) : null}
          {needsMail ? (
            <p
              role="status"
              className="rounded-md border border-warning/40 bg-warning-surface p-2 text-sm"
            >
              {t`This instance sends no email, so it cannot confirm a new address. Open the invitation link you were sent, or ask an administrator to add you.`}
            </p>
          ) : (
            <>
              <Label htmlFor="email">{t`Email`}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              {mode === "signup" ? (
                <>
                  <Label htmlFor="name">{t`Display name`}</Label>
                  <Input
                    id="name"
                    required
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </>
              ) : null}
              <Label htmlFor="password">{t`Password`}</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={mode === "signup" ? minLength : 12}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {mode === "signup" ? (
                <p className="text-xs text-muted-foreground">
                  {t`At least ${{ minLength }} characters.`}
                </p>
              ) : null}
              {mode === "login" && ssoOnly ? (
                <p className="text-xs text-muted-foreground">
                  {t`This instance uses single sign-on. A password works only for administrators.`}
                </p>
              ) : null}
              {mode === "login" && instance.data?.selfReset ? (
                <button
                  type="button"
                  className="self-end text-xs text-primary hover:underline"
                  onClick={() => {
                    setForgot(true);
                    setError("");
                  }}
                >
                  {t`Forgot your password?`}
                </button>
              ) : null}
              {mode === "signup" && policy !== "open" ? (
                <p className="rounded-md border border-warning/40 bg-warning-surface p-2 text-xs">
                  {policy === "invite"
                    ? t`Sign-up is by invitation: use the address that received it.`
                    : t`Sign-up is closed on this instance. Ask an administrator for access.`}
                </p>
              ) : null}
              <Button type="submit" disabled={busy}>
                {mode === "login" ? t`Sign in` : t`Create account`}
              </Button>
            </>
          )}
          {providers.data?.oidc ? (
            <Button variant="outline" asChild>
              <a href={`/auth/oidc/start`}>{t`Sign in with OIDC`}</a>
            </Button>
          ) : null}
          {providers.data?.saml ? (
            <Button variant="outline" asChild>
              <a href={`/auth/saml/start`}>{t`Sign in with SAML`}</a>
            </Button>
          ) : null}
          <p className="text-center text-sm text-muted-foreground">
            {mode === "login" &&
            (policy === "closed" || ssoOnly) ? null : mode === "login" ? (
              <Link
                className="text-primary hover:underline"
                to="/signup"
                search={{ next }}
              >
                {t`No account yet? Create one`}
              </Link>
            ) : (
              <Link
                className="text-primary hover:underline"
                to="/login"
                search={{ next }}
              >
                {t`Already have an account? Sign in`}
              </Link>
            )}
          </p>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </AuthFrame>
  );
}
