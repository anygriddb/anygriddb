import { Button, Input, Label, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { useWhen } from "../../lib/i18n";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import { useStepUp } from "./step-up";

/**
 * Applications that ask a person for access (ADR 0094): an administrator
 * registers each one with its redirect URIs; the secret is shown once.
 */
export function OauthClientsTab() {
  const { t } = useLingui();
  const date = useWhen().instant;
  const copy = useCopy();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const listed = useQuery(api.admin.oauthClients.list.queryOptions());
  const [name, setName] = useState("");
  const [redirectUri, setRedirectUri] = useState(
    "http://127.0.0.1:3000/callback",
  );
  const [fresh, setFresh] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);
  const [revoking, setRevoking] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.admin.oauthClients.list.queryKey(),
    });

  if (listed.isError) {
    return (
      <LoadFailed error={listed.error} onRetry={() => void listed.refetch()} />
    );
  }
  if (!listed.data) return <Spinner />;

  const live = listed.data.filter((client) => !client.revokedAt);
  const gone = listed.data.filter((client) => client.revokedAt);

  return (
    <div className="flex max-w-3xl flex-col gap-4 text-sm">
      <RuledSection
        title={t`Applications`}
        description={t`An application asks a person for access to bases they choose, then calls the API and MCP with a token. Register it here with the addresses it may send the person back to.`}
      >
        {fresh ? (
          <div className="flex flex-col gap-2 rounded border border-rule bg-muted/30 p-3">
            <p className="font-medium">
              {t`Copy the client id and secret now. The secret is shown once.`}
            </p>
            <Label htmlFor="oauth-fresh-id">{t`Client id`}</Label>
            <div className="flex gap-2">
              <Input
                id="oauth-fresh-id"
                readOnly
                value={fresh.clientId}
                onFocus={(event) => event.target.select()}
              />
              <Button
                reads
                size="icon"
                variant="outline"
                aria-label={t`Copy the client id`}
                onClick={() => copy(fresh.clientId, t`Client id copied`)}
              >
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <Label htmlFor="oauth-fresh-secret">{t`Client secret`}</Label>
            <div className="flex gap-2">
              <Input
                id="oauth-fresh-secret"
                readOnly
                value={fresh.clientSecret}
                onFocus={(event) => event.target.select()}
              />
              <Button
                reads
                size="icon"
                variant="outline"
                aria-label={t`Copy the client secret`}
                onClick={() =>
                  copy(fresh.clientSecret, t`Client secret copied`)
                }
              >
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <Button
              reads
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => setFresh(null)}
            >
              {t`Done`}
            </Button>
          </div>
        ) : null}

        {live.length === 0 ? (
          <p className="text-muted-foreground">
            {t`No application yet. Register one below.`}
          </p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">{t`Name`}</th>
                <th className="px-2 py-1.5 font-medium">{t`Client id`}</th>
                <th className="px-2 py-1.5 font-medium">{t`Redirect URIs`}</th>
                <th className="px-2 py-1.5 font-medium">{t`Created`}</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {live.map((client) => (
                <tr key={client.id} className="border-t border-border">
                  <td className="px-2 py-1.5 font-medium">{client.name}</td>
                  <td className="px-2 py-1.5 font-mono text-[11px]">
                    {client.clientId}
                  </td>
                  <td className="px-2 py-1.5">
                    {client.redirectUris.join(", ")}
                  </td>
                  <td className="px-2 py-1.5">{date(client.createdAt)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t`Revoke ${{ name: client.name }}`}
                      onClick={() =>
                        setRevoking({ id: client.id, name: client.name })
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              try {
                if (!(await stepUp.ensure())) return;
                const created = await trpc.admin.oauthClients.create.mutate({
                  name: name.trim(),
                  redirectUris: [redirectUri.trim()],
                });
                setFresh({
                  clientId: created.clientId,
                  clientSecret: created.clientSecret,
                });
                setName("");
                await refresh();
              } catch (cause) {
                toast.error(errorText(cause));
              }
            })();
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <Label htmlFor="oauth-client-name">{t`Name`}</Label>
              <Input
                id="oauth-client-name"
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex min-w-60 flex-[2] flex-col gap-1">
              <Label htmlFor="oauth-redirect">{t`Redirect URI`}</Label>
              <Input
                id="oauth-redirect"
                maxLength={2_000}
                value={redirectUri}
                onChange={(event) => setRedirectUri(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={!name.trim() || !redirectUri.trim()}
            >
              {t`Register`}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t`HTTPS, or http on 127.0.0.1 / localhost for development.`}
          </p>
        </form>
      </RuledSection>

      {gone.length > 0 ? (
        <RuledSection title={t`Revoked`}>
          <ul className="divide-y divide-border text-xs text-muted-foreground">
            {gone.map((client) => (
              <li key={client.id} className="flex gap-3 py-1.5">
                <span className="font-medium text-foreground">
                  {client.name}
                </span>
                <span className="font-mono">{client.clientId}</span>
                <span className="ml-auto">{date(client.revokedAt)}</span>
              </li>
            ))}
          </ul>
        </RuledSection>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t`Revoke “${{ name: revoking?.name ?? "" }}”?`}
        description={t`The application can no longer get new tokens. Tokens it already holds stop working.`}
        confirmLabel={t`Revoke`}
        danger
        onConfirm={async () => {
          if (!revoking) return;
          try {
            if (!(await stepUp.ensure())) return;
            await trpc.admin.oauthClients.revoke.mutate({
              clientId: revoking.id,
            });
            setRevoking(null);
            await refresh();
          } catch (cause) {
            toast.error(errorText(cause));
          }
        }}
      />
      {stepUp.dialog}
    </div>
  );
}
