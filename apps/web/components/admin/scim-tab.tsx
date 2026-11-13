import { Button, Input, Label, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * Provisioning by an identity provider (SCIM 2.0): its address, the tokens
 * it signs in with, and the groups it keeps.
 */
export function ScimTab() {
  const { t } = useLingui();
  const copy = useCopy();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.scim.settings.queryOptions());
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null,
  );

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.admin.scim.settings.queryKey(),
    });

  if (settings.isError) {
    return (
      <LoadFailed
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  if (!settings.data) return <Spinner />;
  const { url, tokens, groups } = settings.data;
  return (
    <div className="flex max-w-3xl flex-col gap-4 text-sm">
      <RuledSection
        title={t`SCIM 2.0 provisioning`}
        description={t`Your identity provider (Okta, Microsoft Entra ID, …) creates, changes, and deactivates accounts, and keeps groups. Existing accounts are taken over by their email. Local groups are made under People → Groups. Then give groups a role in each base's settings or in Administration.`}
      >
        <Label htmlFor="scim-url">{t`SCIM address`}</Label>
        <div className="flex gap-2">
          <Input
            id="scim-url"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
          <Button
            reads
            size="icon"
            variant="outline"
            aria-label={t`Copy the SCIM address`}
            onClick={() => copy(url, t`Address copied`)}
          >
            <Copy className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </RuledSection>

      <RuledSection
        title={t`Tokens`}
        description={t`A token acts with the rights of the administrator who made it, and stops working if they are no longer an administrator.`}
      >
        {fresh ? (
          <div className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p>{t`Copy this token now: it will not be shown again.`}</p>
            <div className="flex gap-2">
              <Input
                readOnly
                aria-label={t`New token`}
                value={fresh}
                onFocus={(event) => event.target.select()}
              />
              <Button
                size="icon"
                variant="outline"
                aria-label={t`Copy the token`}
                onClick={() => copy(fresh, t`Token copied`)}
              >
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setFresh(null)}
            >
              {t`It's copied`}
            </Button>
          </div>
        ) : null}
        {tokens.length > 0 ? (
          <table className="w-full text-left">
            <thead className="bg-muted text-xs">
              <tr>
                <th className="px-2 py-1.5">{t`Name`}</th>
                <th className="px-2 py-1.5">{t`Created by`}</th>
                <th className="px-2 py-1.5">{t`Created`}</th>
                <th className="px-2 py-1.5">{t`Expires`}</th>
                <th className="px-2 py-1.5">{t`Last used`}</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id} className="border-t border-border">
                  <td className="px-2 py-1.5 font-medium">{token.name}</td>
                  <td className="px-2 py-1.5">
                    {token.createdBy}
                    {token.active ? null : (
                      <span className="ml-1 text-xs text-destructive">
                        {t`(inactive: no longer an administrator)`}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {date(token.createdAt)}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {date(token.expiresAt)}
                    {new Date(token.expiresAt) <= new Date() ? (
                      <span className="ml-1 text-destructive">
                        {t`(expired)`}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    {date(token.lastUsedAt)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t`Revoke the token ${{ name: token.name }}`}
                      onClick={() =>
                        setRevoking({ id: token.id, name: token.name })
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t`No token yet. Create one below and give it to your identity provider, which adds and updates accounts and groups with it.`}
          </p>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              try {
                const created = await trpc.admin.scim.createToken.mutate({
                  name,
                });
                setFresh(created.token);
                setName("");
                await refresh();
              } catch (cause) {
                toast.error(errorText(cause));
              }
            })();
          }}
        >
          <div className="flex min-w-60 flex-1 flex-col gap-1">
            <Label htmlFor="scim-token-name">{t`Token name`}</Label>
            <Input
              id="scim-token-name"
              placeholder="Okta"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={!name.trim()}>
            {t`Create a token`}
          </Button>
        </form>
      </RuledSection>

      <RuledSection title={t`Groups`}>
        {groups.length === 0 ? (
          <p className="text-muted-foreground">{t`No group received yet.`}</p>
        ) : (
          <ul className="divide-y divide-border">
            {groups.map((group) => (
              <li key={group.id} className="flex items-center gap-3 py-1.5">
                <span className="flex-1 font-medium">{group.displayName}</span>
                <span className="text-xs text-muted-foreground">
                  {plural(group.members, {
                    one: `# member`,
                    other: `# members`,
                  })}
                </span>
                <span className="w-24 text-right text-xs text-muted-foreground">
                  {plural(group.bases, { one: `# base`, other: `# bases` })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t`Revoke “${{ name: revoking?.name ?? "" }}”?`}
        description={t`The identity provider will no longer be able to provision anything with this token.`}
        confirmLabel={t`Revoke`}
        danger
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await trpc.admin.scim.revokeToken.mutate({ tokenId: revoking.id });
            setRevoking(null);
            await refresh();
          } catch (cause) {
            toast.error(errorText(cause));
          }
        }}
      />
    </div>
  );
}
