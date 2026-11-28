import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { useLingui } from "@lingui/react/macro";
import { refusedAs, useErrorText } from "../../lib/errors";
import { LoadFailed } from "../shell/load-failed";
import { AuthFrame } from "../auth/auth-frame";

export function InvitationPage({ token }: { token: string }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const roleLabel = useRoleLabel();
  const preview = useQuery({
    ...api.auth.invitation.queryOptions({ token }),
    retry: false,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const next = `/invite/${token}`;

  async function accept() {
    setError("");
    setBusy(true);
    try {
      const accepted = await trpc.auth.acceptInvitation.mutate({ token });
      await queryClient.invalidateQueries();
      void navigate({
        to: "/b/$baseId",
        params: { baseId: accepted.baseId },
        replace: true,
      });
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  // The frame of every page outside the app, as sign-in and reset are.
  return (
    <AuthFrame>
      <h1 className="mb-6 text-2xl font-semibold">
        {preview.data
          ? t`Invitation to “${{ name: preview.data.baseName }}”`
          : t`Invitation`}
      </h1>
      <div className="flex flex-col gap-4">
        {preview.isLoading ? <Spinner /> : null}
        {preview.isError ? (
          refusedAs(preview.error, "invalid_invitation") ? (
            <>
              <p role="alert" className="text-sm">
                {t`This invitation does not exist or has expired.`}
              </p>
              <Link
                className="text-sm text-primary hover:underline"
                to="/login"
              >
                {t`Back to sign-in`}
              </Link>
            </>
          ) : (
            <LoadFailed
              error={preview.error}
              onRetry={() => void preview.refetch()}
            />
          )
        ) : null}
        {preview.data ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t`Offered role: ${{ role: roleLabel(preview.data.role) }}. Sent to ${{ email: preview.data.email }}.`}
            </p>
            {session.data ? (
              <Button disabled={busy} onClick={() => void accept()}>
                {t`Accept the invitation`}
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link to="/signup" search={{ next }}>
                    {t`Create an account`}
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to="/login" search={{ next }}>
                    {t`Sign in`}
                  </Link>
                </Button>
              </div>
            )}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </AuthFrame>
  );
}
