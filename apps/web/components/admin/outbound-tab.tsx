import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { sortRows } from "../../lib/sort-rows";
import { useWhen } from "../../lib/i18n";
import { useColumnSort } from "../sort-header";
import { ConfirmDialog } from "../shell/dialogs";
import { AdminPager, AdminTable, AdminTableHead } from "./admin-list";
import { useAdminPage, useAdminPageSize } from "./admin-page-size";

type Link = RouterOutputs["admin"]["outbound"]["list"]["links"][number];

/**
 * Every public link and calendar feed of the instance (ROADMAP #16): what
 * lets a view be read from outside its base, by whom it was made, and a
 * way to stop it. Metadata only: never a value, a token, or a password.
 */
export function OutboundTab() {
  const { t } = useLingui();
  const date = useWhen().instant;
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [pageSize, setPageSize] = useAdminPageSize();
  const { page, setPage, offset, limit } = useAdminPage(pageSize);
  const outbound = useQuery({
    ...api.admin.outbound.list.queryOptions({ limit, offset }),
    placeholderData: (previous) => previous,
  });
  const [revoking, setRevoking] = useState<Link | null>(null);
  const columns = useColumnSort<
    "what" | "view" | "author" | "created" | "ends"
  >();
  const links = sortRows(
    outbound.data?.links ?? [],
    columns.sort,
    (link, key) => {
      if (key === "what") return link.kind;
      if (key === "view") return link.view;
      if (key === "author") return link.author;
      if (key === "created") return link.createdAt;
      return link.kind === "feed" ? link.lastUsedAt : link.expiresAt;
    },
    (link) => `${link.kind}:${link.id}`,
  );
  const total = outbound.data?.total ?? 0;
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
        <>
          <AdminTable>
            <AdminTableHead>
              <tr>
                {columns.header("what", t`What`, "px-3 py-2")}
                {columns.header("view", t`View`, "px-3 py-2")}
                {columns.header("author", t`Made by`, "px-3 py-2")}
                {columns.header("created", t`Created`, "px-3 py-2")}
                {columns.header("ends", t`Ends, or last read`, "px-3 py-2")}
                <th className="px-3 py-2">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </AdminTableHead>
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
          </AdminTable>
          <AdminPager
            total={total}
            offset={offset}
            pageSize={pageSize}
            onPageSize={setPageSize}
            onPrev={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
          />
        </>
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
