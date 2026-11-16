import { Button, Checkbox, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useCatalog, useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { LoadFailed } from "../shell/load-failed";
import { NotebookPage } from "../shell/notebook-page";

export type OauthConsentSearch = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
};

/**
 * A person allows an application access to bases they choose (ADR 0094).
 * The application sent them here with client_id, redirect_uri,
 * code_challenge, and state; after consent they go back with a code.
 */
export function OauthConsentPage({ search }: { search: OauthConsentSearch }) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const session = useSession();
  const catalog = useCatalog();
  const api = useTRPC();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [readOnly, setReadOnly] = useState(true);
  const [busy, setBusy] = useState(false);

  const clientId = search.client_id;
  const redirectUri = search.redirect_uri;
  const codeChallenge = search.code_challenge;
  const state = search.state;

  const client = useQuery({
    ...api.auth.oauthClient.queryOptions({ clientId }),
    enabled: Boolean(session.data && clientId),
  });

  const bases = catalog.data ?? [];
  const clientName = client.data?.name ?? clientId;

  if (!session.data) {
    return (
      <NotebookPage title={t`Allow access`}>
        <Spinner />
      </NotebookPage>
    );
  }

  if (!clientId || !redirectUri || !codeChallenge) {
    return (
      <NotebookPage title={t`Allow access`}>
        <p className="text-sm text-muted-foreground">
          {t`This link is incomplete. Open it again from the application.`}
        </p>
      </NotebookPage>
    );
  }

  if (catalog.isError) {
    return (
      <NotebookPage title={t`Allow access`}>
        <LoadFailed
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      </NotebookPage>
    );
  }

  if (client.isError || client.data === null) {
    return (
      <NotebookPage title={t`Allow access`}>
        <p className="text-sm text-muted-foreground">
          {t`This application is unknown or no longer allowed.`}
        </p>
      </NotebookPage>
    );
  }

  return (
    <NotebookPage
      title={t`Allow access`}
      description={t`${{ name: clientName }} asks to reach bases you choose, through the API and MCP.`}
    >
      <div className="flex max-w-lg flex-col gap-4 text-sm">
        {bases.length === 0 ? (
          <p className="text-muted-foreground">
            {t`You have no base to share yet.`}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {bases.map((base) => (
              <li key={base.id} className="flex items-center gap-2 py-2">
                <Checkbox
                  checked={chosen.has(base.id)}
                  onChange={(event) => {
                    const on = event.target.checked;
                    setChosen((current) => {
                      const next = new Set(current);
                      if (on) next.add(base.id);
                      else next.delete(base.id);
                      return next;
                    });
                  }}
                  aria-label={base.name}
                />
                <span>{base.name}</span>
              </li>
            ))}
          </ul>
        )}
        <label className="flex items-center gap-2">
          <Checkbox
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
          />
          <span>{t`Read only`}</span>
        </label>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              const deny = new URL(redirectUri);
              deny.searchParams.set("error", "access_denied");
              if (state) deny.searchParams.set("state", state);
              window.location.assign(deny.toString());
            }}
          >
            {t`Deny`}
          </Button>
          <Button
            disabled={busy || chosen.size === 0 || client.isLoading}
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  const { code } = await trpc.auth.oauthConsent.mutate({
                    clientId,
                    redirectUri,
                    codeChallenge,
                    baseIds: [...chosen],
                    readOnly,
                  });
                  const next = new URL(redirectUri);
                  next.searchParams.set("code", code);
                  if (state) next.searchParams.set("state", state);
                  window.location.assign(next.toString());
                } catch (cause) {
                  toast.error(errorText(cause));
                  setBusy(false);
                }
              })();
            }}
          >
            {t`Allow`}
          </Button>
          <Button
            reads
            variant="ghost"
            onClick={() => void navigate({ to: "/" })}
          >
            {t`Cancel`}
          </Button>
        </div>
      </div>
    </NotebookPage>
  );
}
