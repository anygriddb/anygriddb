import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { trpc } from "../../lib/trpc";
import { useErrorText } from "../../lib/errors";

/**
 * Applies a signed unsubscribe link from a notification email (ADR 0126).
 * No session: the token names the person and the channel to drop.
 */
export function UnsubscribePage({ token }: { token: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "done" }
    | { status: "required"; event: string }
    | { status: "invalid" }
    | { status: "error"; message: string }
  >({ status: "idle" });

  async function apply() {
    try {
      const result = await trpc.notifications.unsubscribe.mutate({ token });
      if (result.ok) {
        setState({ status: "done" });
        return;
      }
      if (result.reason === "required") {
        setState({ status: "required", event: result.event });
        return;
      }
      setState({ status: "invalid" });
    } catch (cause) {
      setState({ status: "error", message: errorText(cause) });
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="font-display text-2xl text-primary">{t`Email notices`}</h1>
      {state.status === "idle" ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t`Stop immediate email for this kind of notice. You can change every preference again from your account.`}
          </p>
          <Button onClick={() => void apply()}>{t`Confirm`}</Button>
        </>
      ) : null}
      {state.status === "done" ? (
        <p role="status" className="text-sm">
          {t`That preference is updated. You will not get this kind of notice by immediate email anymore.`}
        </p>
      ) : null}
      {state.status === "required" ? (
        <p role="alert" className="text-sm text-warning">
          {t`This notice cannot be turned off: it warns you about your account or an administrator using emergency powers.`}
        </p>
      ) : null}
      {state.status === "invalid" ? (
        <p role="alert" className="text-sm text-danger">
          {t`This link is not valid or has already been used.`}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      ) : null}
      <Link to="/login" className="text-sm underline">
        {t`Sign in`}
      </Link>
    </main>
  );
}
