import { Button, Input, Label, Select } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useCopy } from "../../lib/clipboard";
import { useErrorText } from "../../lib/errors";
import { useWhen } from "../../lib/i18n";
import { trpc, useTRPC } from "../../lib/trpc";
import { RuledSection } from "../shell/notebook-page";
import { RevokeLink } from "../table/revoke-link";

/**
 * Links that show the whole base read-only (ROADMAP row 93), each table as
 * the person who made the link reads it, with a view's link's password and
 * expiry. A link is shown once, when it is made.
 */
export function BaseLinks({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const copy = useCopy();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const shares = useQuery(api.catalog.baseShares.queryOptions({ baseId }));
  // The instance's rule for public links (ADR 0043).
  const instance = useQuery(api.auth.instance.queryOptions());
  const links = instance.data?.publicLinks ?? "allowed";
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("");
  const [link, setLink] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const when = useWhen();
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.catalog.baseShares.queryKey({ baseId }),
    });
  const live = (shares.data?.shares ?? []).filter((share) => !share.revoked);

  return (
    <RuledSection
      title={t`Read-only link`}
      description={t`Anyone with the link reads every table of the base, as you read them, and changes nothing. Files stay out.`}
    >
      {links === "off" ? (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning-surface p-2 text-sm"
        >
          {t`An administrator turned public links off on this instance. Links made before no longer open.`}
        </p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const created = await trpc.catalog.createBaseShare.mutate({
                baseId,
                password: password || undefined,
                expiresInDays: days ? Number(days) : undefined,
              });
              setLink(`${window.location.origin}/s/b/${created.token}`);
              setPassword("");
              await refresh();
            } catch (cause) {
              toast.error(errorText(cause));
            }
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="base-link-password">
              {links === "password" ? t`Password` : t`Password (optional)`}
            </Label>
            <Input
              id="base-link-password"
              type="password"
              minLength={8}
              required={links === "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="base-link-days">{t`Expiry`}</Label>
            <Select
              id="base-link-days"
              className="w-36"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            >
              <option value="">{t`Never`}</option>
              <option value="1">{t`1 day`}</option>
              <option value="7">{t`7 days`}</option>
              <option value="30">{t`30 days`}</option>
              <option value="90">{t`90 days`}</option>
            </Select>
          </div>
          <Button type="submit" size="sm" variant="outline">
            <Link2 className="h-4 w-4" aria-hidden />
            {t`Make a read-only link`}
          </Button>
        </form>
      )}
      {link ? (
        <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-accent/40 p-2">
          <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
          <Button
            size="xs"
            variant="outline"
            onClick={() => copy(link, t`Link copied`)}
          >
            {t`Copy`}
          </Button>
        </div>
      ) : null}
      {live.length > 0 ? (
        <ul className="divide-y divide-border text-sm">
          {live.map((share) => (
            <li key={share.id} className="flex items-center gap-2 py-1.5">
              {share.protected ? (
                <Lock
                  className="h-3.5 w-3.5 opacity-60"
                  aria-label={t`Password protected`}
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                {t`Created by ${{ name: share.createdBy }} on ${{ date: when.instant(share.createdAt) }}`}
                {share.expiresAt
                  ? ` · ${t`expires on ${{ date: when.day(share.expiresAt) }}`}`
                  : ""}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setRevoking(share.id)}
              >
                {t`Revoke`}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <RevokeLink
        shareId={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={refresh}
      />
    </RuledSection>
  );
}
