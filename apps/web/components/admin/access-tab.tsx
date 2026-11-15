import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { AdminPager, AdminTable, AdminTableHead } from "./admin-list";
import { useAdminPage, useAdminPageSize } from "./admin-page-size";

type Access = RouterOutputs["admin"]["access"]["list"];
type Token = Access["tokens"][number];
type Hook = Access["webhooks"][number];

function date(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * The API tokens, outgoing webhooks, and automations of the whole
 * instance (ROADMAP #23): who owns each, whether it is on, how it was last
 * used, and a way to stop it without being in its base.
 */
export function AccessTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [pageSize, setPageSize] = useAdminPageSize();
  const tokensPage = useAdminPage(pageSize);
  const webhooksPage = useAdminPage(pageSize);
  const automationsPage = useAdminPage(pageSize);
  const access = useQuery({
    ...api.admin.access.list.queryOptions({
      limit: pageSize,
      tokensOffset: tokensPage.offset,
      webhooksOffset: webhooksPage.offset,
      automationsOffset: automationsPage.offset,
    }),
    placeholderData: (previous) => previous,
  });
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [stopping, setStopping] = useState<Hook | null>(null);
  const tokens = access.data?.tokens ?? [];
  const webhooks = access.data?.webhooks ?? [];
  const automations = access.data?.automations ?? [];
  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: api.admin.access.list.queryKey(),
      });
      toast.success(t`Done`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  const head = "px-3 py-2";
  const cell = "px-3 py-2 text-xs";
  return (
    <div className="flex flex-col gap-6">
      {access.isLoading ? <Spinner /> : null}
      {access.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(access.error)}
        </p>
      ) : null}
      <section className="flex flex-col gap-2" aria-labelledby="access-tokens">
        <h2 id="access-tokens" className="text-sm font-semibold">
          {t`API tokens`}
        </h2>
        {access.data && tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t`No API token.`}</p>
        ) : null}
        {tokens.length > 0 ? (
          <>
            <AdminTable>
              <AdminTableHead>
                <tr>
                  <th className={head}>{t`Token`}</th>
                  <th className={head}>{t`Owner`}</th>
                  <th className={head}>{t`Reaches`}</th>
                  <th className={head}>{t`Last used`}</th>
                  <th className={head}>{t`Ends`}</th>
                  <th className={head}>
                    <span className="sr-only">{t`Actions`}</span>
                  </th>
                </tr>
              </AdminTableHead>
              <tbody>
                {tokens.map((token) => (
                  <tr key={token.id} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{token.name}</td>
                    <td className={cell}>{token.owner}</td>
                    <td className={cell}>
                      {token.bases === null
                        ? t`Every base of its owner`
                        : plural(token.bases, {
                            one: "# base",
                            other: "# bases",
                          })}
                      {token.readOnly ? ` · ${t`Read only`}` : ""}
                    </td>
                    <td className={cell}>
                      {token.lastUsedAt ? date(token.lastUsedAt) : t`Never`}
                    </td>
                    <td className={cell}>
                      {token.expired
                        ? t`Ended ${{ when: date(token.expiresAt) }}`
                        : date(token.expiresAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRevoking(token)}
                      >
                        {t`Revoke`}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
            <AdminPager
              total={access.data?.tokensTotal ?? 0}
              offset={tokensPage.offset}
              pageSize={pageSize}
              onPageSize={setPageSize}
              onPrev={() => tokensPage.setPage(tokensPage.page - 1)}
              onNext={() => tokensPage.setPage(tokensPage.page + 1)}
            />
          </>
        ) : null}
      </section>
      {(
        [
          [
            "webhook",
            t`Webhooks`,
            webhooks,
            access.data?.webhooksTotal ?? 0,
            webhooksPage,
            t`No webhook.`,
          ],
          [
            "automation",
            t`Automations`,
            automations,
            access.data?.automationsTotal ?? 0,
            automationsPage,
            t`No automation.`,
          ],
        ] as const
      ).map(([kind, title, list, total, pager, empty]) => (
        <section
          key={kind}
          className="flex flex-col gap-2"
          aria-labelledby={`access-${kind}`}
        >
          <h2 id={`access-${kind}`} className="text-sm font-semibold">
            {title}
          </h2>
          {access.data && list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{empty}</p>
          ) : null}
          {list.length > 0 ? (
            <>
              <AdminTable>
                <AdminTableHead>
                  <tr>
                    <th className={head}>{t`Name`}</th>
                    <th className={head}>{t`Table`}</th>
                    <th className={head}>{t`Owner`}</th>
                    <th className={head}>{t`State`}</th>
                    <th className={head}>
                      {kind === "webhook" ? t`Sends to` : t`Last run`}
                    </th>
                    <th className={head}>
                      <span className="sr-only">{t`Actions`}</span>
                    </th>
                  </tr>
                </AdminTableHead>
                <tbody>
                  {list.map((hook) => (
                    <tr key={hook.id} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{hook.name}</td>
                      <td className={cell}>
                        {hook.table}
                        <span className="block text-muted-foreground">
                          {hook.base}
                        </span>
                      </td>
                      <td className={cell}>{hook.owner ?? "—"}</td>
                      <td className={cell}>
                        {hook.on ? t`Switched on` : t`Switched off`}
                        {hook.failures > 0 ? (
                          <span className="block text-warning">
                            {kind === "webhook"
                              ? plural(hook.failures, {
                                  one: "# failure",
                                  other: "# failures in a row",
                                })
                              : plural(hook.failures, {
                                  one: "# failed run in 24 hours",
                                  other: "# failed runs in 24 hours",
                                })}
                          </span>
                        ) : null}
                      </td>
                      <td className={cell}>
                        {kind === "webhook"
                          ? (hook.host ?? "—")
                          : hook.lastRunAt
                            ? date(hook.lastRunAt)
                            : t`Never`}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {hook.on ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setStopping(hook)}
                          >
                            {t`Switch off`}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </AdminTable>
              <AdminPager
                total={total}
                offset={pager.offset}
                pageSize={pageSize}
                onPageSize={setPageSize}
                onPrev={() => pager.setPage(pager.page - 1)}
                onNext={() => pager.setPage(pager.page + 1)}
              />
            </>
          ) : null}
        </section>
      ))}
      {revoking ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setRevoking(null)}
          title={t`Revoke ${{ name: revoking.name }}?`}
          description={t`Whatever uses this token is refused from now on. Its owner can make another.`}
          confirmLabel={t`Revoke`}
          onConfirm={() =>
            run(() => trpc.admin.access.revokeToken.mutate({ id: revoking.id }))
          }
        />
      ) : null}
      {stopping ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setStopping(null)}
          title={t`Switch off ${{ name: stopping.name }}?`}
          description={t`It stops running now and keeps its settings: someone who manages its base can switch it on again.`}
          confirmLabel={t`Switch off`}
          onConfirm={() =>
            run(() =>
              trpc.admin.access.switchOff.mutate({
                kind: stopping.kind,
                id: stopping.id,
              }),
            )
          }
        />
      ) : null}
    </div>
  );
}
