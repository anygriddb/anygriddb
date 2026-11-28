import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { trpc } from "../../lib/trpc";
import { useErrorText } from "../../lib/errors";
import { AuthFrame } from "../auth/auth-frame";

/**
 * Applies a signed unsubscribe link from a notification email (ADR 0123).
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
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
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
    setBusy(false);
  }

  // The frame of every page outside the app, as sign-in and reset are.
  return (
    <AuthFrame>
      <h1 className="mb-6 text-2xl font-semibold">{t`Email notices`}</h1>
      <div className="flex flex-col gap-4">
        {state.status === "idle" ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t`Stop these notices by email. Every other choice stays as it is, and you can change them all again from your account.`}
            </p>
            <Button disabled={busy} onClick={() => void apply()}>
              {t`Stop these emails`}
            </Button>
          </>
        ) : null}
        {state.status === "done" ? (
          <p role="status" className="text-sm">
            {t`Done: these notices no longer come by email.`}
          </p>
        ) : null}
        {state.status === "required" ? (
          <p role="alert" className="text-sm text-warning">
            {t`This notice cannot be turned off: it warns you about your account or an administrator using emergency powers.`}
          </p>
        ) : null}
        {state.status === "invalid" ? (
          <p role="alert" className="text-sm text-danger">
            {t`This link is not valid.`}
          </p>
        ) : null}
        {state.status === "error" ? (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        ) : null}
        <Link to="/login" className="text-sm text-primary hover:underline">
          {t`Sign in`}
        </Link>
      </div>
    </AuthFrame>
  );
}
