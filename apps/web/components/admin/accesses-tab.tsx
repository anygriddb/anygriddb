import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { plural } from "@lingui/core/macro";
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

type Access = RouterOutputs["admin"]["access"]["list"]["accesses"][number];

/**
 * Everything that reaches the instance without a session (ADR 0131, §5;
 * ROADMAP #16): every token, application, feed, link and automation's
 * address, by its author, reach, end, last use and state, and a way to
 * stop each. Metadata only: never a value, a secret, or a password.
 */
export function AccessesTab() {
  const { t } = useLingui();
  const date = useWhen().instant;
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [pageSize, setPageSize] = useAdminPageSize();
  const { page, setPage, offset, limit } = useAdminPage(pageSize);
  const listed = useQuery({
    ...api.admin.access.list.queryOptions({ limit, offset }),
    placeholderData: (previous) => previous,
  });
  const [revoking, setRevoking] = useState<Access | null>(null);
  const columns = useColumnSort<
    "what" | "reach" | "author" | "created" | "state"
  >();
  const kindLabel = (kind: Access["kind"]): string =>
    ({
      api_token: t`API token`,
      application: t`Application`,
      admin_token: t`Administration API`,
      scim_token: t`Provisioning (SCIM)`,
      feed: t`Calendar feed`,
      link: t`Public link`,
      inbound_hook: t`Webhook address`,
    })[kind];
  const reachLabel = (access: Access): string => {
    if (access.kind === "admin_token" || access.kind === "scim_token") {
      return t`Administration`;
    }
    if (access.automation)
      return `${access.automation} · ${access.table ?? ""}`;
    if (access.view) return `${access.view} · ${access.table ?? ""}`;
    if (access.base) return t`The whole base ${{ base: access.base }}`;
    return access.bases === null
      ? t`Every base of its author`
      : plural(access.bases, { one: "# base", other: "# bases" });
  };
  const stateLabel = (access: Access): string =>
    ({
      live: access.endsAt
        ? t`Ends ${{ when: date(access.endsAt) }}`
        : t`No end`,
      ended: access.endsAt
        ? t`Ended ${{ when: date(access.endsAt) }}`
        : t`Ended`,
      revoked: t`Revoked`,
      suspended: t`Suspended: acts on nothing while its author or what it reaches may not`,
    })[access.state];
  const accesses = sortRows(
    listed.data?.accesses ?? [],
    columns.sort,
    (access, key) => {
      if (key === "what") return access.kind;
      if (key === "reach") return reachLabel(access);
      if (key === "author") return access.author;
      if (key === "created") return access.createdAt;
      return access.state;
    },
    (access) => access.id,
  );
  const total = listed.data?.total ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t`Everything that reaches the instance without someone signed in: API tokens and the applications people let in, the tokens of the administration API and of provisioning, calendar feeds, public links, and automations' addresses. Each acts with its author's rights, never more; revoking one stops it at once.`}
      </p>
      {listed.isLoading ? <Spinner /> : null}
      {listed.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(listed.error)}
        </p>
      ) : null}
      {listed.data && accesses.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t`Nothing reaches this instance without a session.`}
        </p>
      ) : null}
      {accesses.length > 0 ? (
        <>
          <AdminTable>
            <AdminTableHead>
              <tr>
                {columns.header("what", t`What`, "px-3 py-2")}
                {columns.header("reach", t`Reaches`, "px-3 py-2")}
                {columns.header("author", t`Made by`, "px-3 py-2")}
                {columns.header("created", t`Created`, "px-3 py-2")}
                {columns.header("state", t`State`, "px-3 py-2")}
                <th className="px-3 py-2">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </AdminTableHead>
            <tbody>
              {accesses.map((access) => (
                <tr key={access.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <p className="font-medium">{kindLabel(access.kind)}</p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        access.name,
                        access.kind === "link"
                          ? access.protected
                            ? t`Password asked`
                            : t`No password`
                          : "",
                        access.readOnly ? t`Read only` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <p>{reachLabel(access)}</p>
                    {access.base && (access.view || access.automation) ? (
                      <p className="text-xs text-muted-foreground">
                        {access.base}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">{access.author}</td>
                  <td className="px-3 py-2 text-xs">
                    <p>{date(access.createdAt)}</p>
                    <p className="text-muted-foreground">
                      {access.lastUsedAt
                        ? t`Used ${{ when: date(access.lastUsedAt) }}`
                        : t`Never used`}
                    </p>
                  </td>
                  <td
                    className={
                      access.state === "suspended"
                        ? "px-3 py-2 text-xs text-warning"
                        : "px-3 py-2 text-xs"
                    }
                  >
                    {stateLabel(access)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {access.state === "revoked" ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t`Revoke: ${{ what: kindLabel(access.kind) }}`}
                        onClick={() => setRevoking(access)}
                      >
                        {t`Revoke`}
                      </Button>
                    )}
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
          title={t`Revoke: ${{ what: kindLabel(revoking.kind) }}?`}
          description={t`It stops working now, for whoever holds it. What it reaches stays as it is; its author can make a new one.`}
          confirmLabel={t`Revoke`}
          onConfirm={async () => {
            await trpc.admin.access.revoke.mutate({ id: revoking.id });
            await queryClient.invalidateQueries({
              queryKey: api.admin.access.list.queryKey(),
            });
            toast.success(t`Revoked`);
          }}
        />
      ) : null}
    </div>
  );
}
