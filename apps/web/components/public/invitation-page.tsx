import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { useRoleLabel } from "../settings/base-settings";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { BrandMark } from "../brand/brand-mark";

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
  const next = `/invite/${token}`;
  return (
    <main className="flex h-screen items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border bg-card p-6">
        <BrandMark className="h-7 w-7" title="AnyGridDB" />
        {preview.isLoading ? <Spinner /> : null}
        {preview.isError ? (
          <p>{t`This invitation does not exist or has expired.`}</p>
        ) : null}
        {preview.data ? (
          <>
            <h1 className="text-lg font-semibold">
              {t`Invitation to “${{ name: preview.data.baseName }}”`}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t`Offered role: ${{ role: roleLabel(preview.data.role) }}. Sent to ${{ email: preview.data.email }}.`}
            </p>
            {session.data ? (
              <Button
                onClick={async () => {
                  setError("");
                  try {
                    const accepted = await trpc.auth.acceptInvitation.mutate({
                      token,
                    });
                    await queryClient.invalidateQueries();
                    void navigate({
                      to: "/b/$baseId",
                      params: { baseId: accepted.baseId },
                      replace: true,
                    });
                  } catch (cause) {
                    setError(errorText(cause));
                  }
                }}
              >
                {t`Accept the invitation`}
              </Button>
            ) : (
              <div className="flex gap-2">
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
    </main>
  );
}
