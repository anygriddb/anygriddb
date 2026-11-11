import { Button, Input, Label, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { AuthFrame } from "./auth-frame";

/**
 * Opening the link a sign-up mailed (ADR 0058). The address is proved by
 * the link, the person by the password chosen at sign-up: the account is
 * made then, and the person signed in.
 */
export function ConfirmSignupPage({ token }: { token: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const link = useQuery({
    ...api.auth.signupLink.queryOptions({ token }),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const email = link.data?.valid ? link.data.email : "";
  return (
    <AuthFrame>
      <h1 className="mb-6 text-2xl font-semibold">{t`Confirm your address`}</h1>
      {link.isLoading ? <Spinner /> : null}
      {link.data && !link.data.valid ? (
        <div className="flex flex-col gap-3">
          <p role="alert" className="text-sm">
            {t`This link no longer works: it was used, it expired, or the account exists already. Sign in, or sign up again.`}
          </p>
          <Link className="text-sm text-primary hover:underline" to="/login">
            {t`Back to sign-in`}
          </Link>
        </div>
      ) : link.data?.valid ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            trpc.auth.confirmSignup
              .mutate({ token, password })
              .then(async () => {
                await queryClient.invalidateQueries();
                await navigate({ to: "/welcome", replace: true });
              })
              .catch((cause: unknown) => setError(errorText(cause)))
              .finally(() => setBusy(false));
          }}
        >
          <p className="text-sm">
            {t`To create the account of ${email}, enter the password you chose when signing up.`}
          </p>
          <Label htmlFor="confirm-password">{t`Password`}</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {t`Create my account`}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </AuthFrame>
  );
}
