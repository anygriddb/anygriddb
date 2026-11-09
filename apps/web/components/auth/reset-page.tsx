import { Button, Input, Label, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { BrandMark } from "../brand/brand-mark";

/**
 * Choosing a new password from a reset link (ADR 0043). The link works
 * once; the account's sessions end, and its second factor stays.
 */
export function ResetPasswordPage({ token }: { token: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const link = useQuery({
    ...api.auth.resetLink.queryOptions({ token }),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const minLength = link.data?.passwordMinLength ?? 12;
  return (
    <main className="flex h-screen items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <BrandMark className="h-7 w-7" />
          <span className="text-lg font-semibold">AnyGridDB</span>
        </div>
        <h1 className="mb-3 text-base font-semibold">
          {t`Choose a new password`}
        </h1>
        {link.isLoading ? <Spinner /> : null}
        {done ? (
          <div className="flex flex-col gap-3">
            <p role="status" className="text-sm">
              {t`Your password is changed, and every session of the account ended. Sign in with the new one.`}
            </p>
            <Button asChild>
              <Link to="/login">{t`Sign in`}</Link>
            </Button>
          </div>
        ) : link.data && !link.data.valid ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-sm">
              {t`This link no longer works: it was used, it expired, or a newer one replaced it. Ask for a new one.`}
            </p>
            <Link className="text-sm text-primary hover:underline" to="/login">
              {t`Back to sign-in`}
            </Link>
          </div>
        ) : link.data ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (password !== again) {
                setError(t`The two passwords differ`);
                return;
              }
              setBusy(true);
              setError("");
              trpc.auth.resetPassword
                .mutate({ token, password })
                .then(() => setDone(true))
                .catch((cause: unknown) => setError(errorText(cause)))
                .finally(() => setBusy(false));
            }}
          >
            <Label htmlFor="reset-password">{t`New password`}</Label>
            <Input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={minLength}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Label htmlFor="reset-again">{t`New password, again`}</Label>
            <Input
              id="reset-again"
              type="password"
              autoComplete="new-password"
              required
              minLength={minLength}
              value={again}
              onChange={(event) => setAgain(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t`At least ${{ minLength }} characters.`}
            </p>
            <Button type="submit" disabled={busy}>
              {t`Set the password`}
            </Button>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
