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
import { BrandMark } from "../brand/brand-mark";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [methods, setMethods] = useState<Array<"totp" | "webauthn">>([]);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  const finishing = useRef(false);
  const minLength = instance.data?.passwordMinLength ?? 12;

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
    await (mode === "signup" && next === "/"
      ? navigate({ to: "/settings", search: { welcome: true }, replace: true })
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
        await trpc.auth.signup.mutate({ email, password, displayName });
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
    <main className="flex h-screen items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <BrandMark className="h-7 w-7" />
          <span className="text-lg font-semibold">AnyGridDB</span>
        </div>
        {forgot ? (
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
            <h1 className="text-base font-semibold">{t`Forgot your password?`}</h1>
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
          <div className="flex flex-col gap-4">
            <h1 className="text-base font-semibold">{t`Second factor`}</h1>
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
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await trpc.auth.backup.verify.mutate({ code: backup });
                  await finish();
                });
              }}
            >
              <Label htmlFor="backup">{t`Backup code`}</Label>
              <Input
                id="backup"
                value={backup}
                onChange={(event) => setBackup(event.target.value)}
              />
              <Button type="submit" variant="outline" disabled={busy}>
                {t`Use the backup code`}
              </Button>
            </form>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={onSubmit}>
            <h1 className="text-base font-semibold">
              {mode === "login" ? t`Sign in` : t`Create an account`}
            </h1>
            {instance.data?.maintenance ? (
              <p
                role="status"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
              >
                {t`The instance is under maintenance: only administrators can sign in for now.`}
                {instance.data.banner ? (
                  <span className="mt-1 block whitespace-pre-line">
                    {instance.data.banner}
                  </span>
                ) : null}
              </p>
            ) : null}
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
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                {policy === "invite"
                  ? t`Sign-up is by invitation: use the address that received it.`
                  : t`Sign-up is closed on this instance. Ask an administrator for access.`}
              </p>
            ) : null}
            <Button type="submit" disabled={busy}>
              {mode === "login" ? t`Sign in` : t`Create account`}
            </Button>
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
              {mode === "login" && policy === "closed" ? null : mode ===
                "login" ? (
                <Link
                  className="text-primary hover:underline"
                  to="/signup"
                  search={{ next }}
                >
                  {t`No account yet? Sign up`}
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
      </div>
    </main>
  );
}
