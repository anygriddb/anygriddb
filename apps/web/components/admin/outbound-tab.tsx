import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";

type Link = RouterOutputs["admin"]["outbound"]["list"]["links"][number];

function date(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * Every public link and calendar feed of the instance (ROADMAP #16): what
 * lets a view be read from outside its base, by whom it was made, and a
 * way to stop it. Metadata only: never a value, a token, or a password.
 */
export function OutboundTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const outbound = useQuery(api.admin.outbound.list.queryOptions());
  const [revoking, setRevoking] = useState<Link | null>(null);
  const links = outbound.data?.links ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t`Public links let anyone with the address read a view or fill a form; a calendar feed gives its owner's calendar program the view's dates. Revoking one stops it at once.`}
      </p>
      {outbound.isLoading ? <Spinner /> : null}
      {outbound.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(outbound.error)}
        </p>
      ) : null}
      {outbound.data && links.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t`No public link or calendar feed on this instance.`}
        </p>
      ) : null}
      {links.length > 0 ? (
        <div className="overflow-x-auto rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs">
              <tr>
                <th className="px-3 py-2">{t`What`}</th>
                <th className="px-3 py-2">{t`View`}</th>
                <th className="px-3 py-2">{t`Made by`}</th>
                <th className="px-3 py-2">{t`Created`}</th>
                <th className="px-3 py-2">{t`Ends, or last read`}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr
                  key={`${link.kind}:${link.id}`}
                  className="border-t border-border"
                >
                  <td className="px-3 py-2">
                    <p className="font-medium">
                      {link.kind === "link" ? t`Public link` : t`Calendar feed`}
                    </p>
                    {link.kind === "link" ? (
                      <p className="text-xs text-muted-foreground">
                        {link.protected ? t`Password asked` : t`No password`}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <p>{link.view}</p>
                    <p className="text-xs text-muted-foreground">
                      {link.base} · {link.table}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-xs">{link.author}</td>
                  <td className="px-3 py-2 text-xs">{date(link.createdAt)}</td>
                  <td className="px-3 py-2 text-xs">
                    {link.kind === "feed"
                      ? link.lastUsedAt
                        ? t`Read ${{ when: date(link.lastUsedAt) }}`
                        : t`Never read`
                      : link.expiresAt
                        ? link.expired
                          ? t`Ended ${{ when: date(link.expiresAt) }}`
                          : t`Ends ${{ when: date(link.expiresAt) }}`
                        : t`No end`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRevoking(link)}
                    >
                      {t`Revoke`}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {revoking ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setRevoking(null)}
          title={
            revoking.kind === "link"
              ? t`Revoke this public link?`
              : t`Remove this calendar feed?`
          }
          description={
            revoking.kind === "link"
              ? t`Its address stops working now, for everyone who has it. The view stays as it is.`
              : t`Its address stops working now; its owner can make a new one. The view stays as it is.`
          }
          confirmLabel={t`Revoke`}
          onConfirm={async () => {
            try {
              await trpc.admin.outbound.revoke.mutate({
                kind: revoking.kind,
                id: revoking.id,
              });
              await queryClient.invalidateQueries({
                queryKey: api.admin.outbound.list.queryKey(),
              });
              toast.success(t`Revoked`);
            } catch (cause) {
              toast.error(errorText(cause));
            }
          }}
        />
      ) : null}
    </div>
  );
}
