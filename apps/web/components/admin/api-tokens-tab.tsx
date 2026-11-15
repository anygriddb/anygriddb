import { Button, Checkbox, Input, Label, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { Copy, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { sortRows } from "../../lib/sort-rows";
import { useColumnSort } from "../sort-header";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";

type Scope = "accounts" | "invitations" | "settings";

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * The administration API (ADR 0086): its address, and the tokens an
 * operator's script calls it with. A token is made for the scopes chosen
 * here, shown once, and revoked from the list. Making one asks for the
 * proof, as every change of Administration does.
 */
export function ApiTokensTab() {
  const { t } = useLingui();
  const copy = useCopy();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const listed = useQuery(api.admin.apiTokens.list.queryOptions());
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [scopes, setScopes] = useState<ReadonlySet<Scope>>(new Set());
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(
    null,
  );
  const columns = useColumnSort<"name" | "may" | "by" | "expires" | "used">();
  const scopeLabels: Record<Scope, { label: string; hint: string }> = {
    accounts: {
      label: t`Accounts`,
      hint: t`Lists the accounts, and makes one. An account made with a token is never an administrator and has no role on a base.`,
    },
    invitations: {
      label: t`Invitations`,
      hint: t`Lists the invitations that wait for an answer.`,
    },
    settings: {
      label: t`Settings`,
      hint: t`Reads the settings, and changes those of the instance's running: maintenance, the banner, alerts, map tiles. Security is changed here only.`,
    },
  };

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.admin.apiTokens.list.queryKey(),
    });

  if (listed.isError) {
    return (
      <LoadFailed error={listed.error} onRetry={() => void listed.refetch()} />
    );
  }
  if (!listed.data) return <Spinner />;
  const { url, tokens: listedTokens } = listed.data;
  const tokens = sortRows(
    listedTokens,
    columns.sort,
    (token, key) => {
      if (key === "name") return token.name;
      if (key === "may") {
        return token.scopes.map((scope) => scopeLabels[scope].label).join(", ");
      }
      if (key === "by") return token.createdBy;
      if (key === "expires") return token.expiresAt;
      return token.lastUsedAt;
    },
    (token) => token.id,
  );
  const document = `${url}/openapi.json`;
  return (
    <div className="flex max-w-3xl flex-col gap-4 text-sm">
      <RuledSection
        title={t`Administration API`}
        description={t`What a script of yours asks of Administration: list and make accounts, list invitations, read the settings and change those of the instance's running. A token gives no proof that it is you, so it does nothing that asks for one here.`}
      >
        <Label htmlFor="admin-api-url">{t`Address of the API`}</Label>
        <div className="flex gap-2">
          <Input
            id="admin-api-url"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
          <Button
            reads
            size="icon"
            variant="outline"
            aria-label={t`Copy the address of the API`}
            onClick={() => copy(url, t`Address copied`)}
          >
            <Copy className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <p className="text-muted-foreground">
          {t`Its requests are described, in OpenAPI 3.1, at:`}{" "}
          <a
            className="text-primary underline-offset-2 hover:underline"
            href={document}
            target="_blank"
            rel="noreferrer"
          >
            {document}
          </a>
        </p>
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
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-muted text-xs">
                <tr>
                  {columns.header("name", t`Name`)}
                  {columns.header("may", t`May`)}
                  {columns.header("by", t`Created by`)}
                  {columns.header("expires", t`Expires`)}
                  {columns.header("used", t`Last used`)}
                  <th scope="col" className="px-2 py-1.5">
                    <span className="sr-only">{t`Actions`}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr key={token.id} className="border-t border-border">
                    <td className="px-2 py-1.5 font-medium">{token.name}</td>
                    <td className="px-2 py-1.5">
                      {token.scopes
                        .map((scope) => scopeLabels[scope].label)
                        .join(", ")}
                    </td>
                    <td className="px-2 py-1.5">
                      {token.createdBy}
                      {token.active ? null : (
                        <span className="ml-1 text-xs text-danger">
                          {t`(inactive: no longer an administrator)`}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs">
                      {date(token.expiresAt)}
                      {new Date(token.expiresAt) <= new Date() ? (
                        <span className="ml-1 text-danger">{t`(expired)`}</span>
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
          </div>
        ) : (
          <p className="text-muted-foreground">
            {t`No token yet. Make one below, for what your script has to do and nothing more.`}
          </p>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              try {
                const created = await trpc.admin.apiTokens.create.mutate({
                  name,
                  scopes: [...scopes],
                  days: Number(days),
                });
                setFresh(created.token);
                setName("");
                setScopes(new Set());
                await refresh();
              } catch (cause) {
                toast.error(errorText(cause));
              }
            })();
          }}
        >
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-60 flex-1 flex-col gap-1">
              <Label htmlFor="admin-token-name">{t`Token name`}</Label>
              <Input
                id="admin-token-name"
                maxLength={80}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex w-32 flex-col gap-1">
              <Label htmlFor="admin-token-days">{t`Days it lives`}</Label>
              <Input
                id="admin-token-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                step={1}
                required
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </div>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">
              {t`What the token may do`}
            </legend>
            {(Object.keys(scopeLabels) as Scope[]).map((scope) => (
              <label key={scope} className="flex items-start gap-2">
                <Checkbox
                  className="mt-0.5"
                  checked={scopes.has(scope)}
                  onChange={(event) => {
                    const next = new Set(scopes);
                    if (event.target.checked) next.add(scope);
                    else next.delete(scope);
                    setScopes(next);
                  }}
                />
                <span>
                  <span className="font-medium">
                    {scopeLabels[scope].label}
                  </span>
                  <span className="block text-muted-foreground">
                    {scopeLabels[scope].hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button
            type="submit"
            className="self-start"
            disabled={!name.trim() || scopes.size === 0}
          >
            {t`Make a token`}
          </Button>
        </form>
      </RuledSection>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t`Revoke “${{ name: revoking?.name ?? "" }}”?`}
        description={t`A script that calls the API with this token will be refused at once.`}
        confirmLabel={t`Revoke`}
        danger
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await trpc.admin.apiTokens.revoke.mutate({ tokenId: revoking.id });
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
