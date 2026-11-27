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

type Hook = RouterOutputs["admin"]["access"]["hooks"]["webhooks"][number];

/**
 * The outgoing webhooks and automations of the whole instance (ROADMAP
 * #23), which act as their authors: who owns each, whether it is on, how
 * it was last used, and a way to stop it without being in its base.
 */
export function AccessTab() {
  const { t } = useLingui();
  const date = useWhen().instant;
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [pageSize, setPageSize] = useAdminPageSize();
  const webhooksPage = useAdminPage(pageSize);
  const automationsPage = useAdminPage(pageSize);
  const access = useQuery({
    ...api.admin.access.hooks.queryOptions({
      limit: pageSize,
      webhooksOffset: webhooksPage.offset,
      automationsOffset: automationsPage.offset,
    }),
    placeholderData: (previous) => previous,
  });
  const [stopping, setStopping] = useState<Hook | null>(null);
  const webhookSort = useColumnSort<
    "name" | "table" | "owner" | "state" | "where"
  >();
  const automationSort = useColumnSort<
    "name" | "table" | "owner" | "state" | "where"
  >();
  const hookValue = (
    hook: Hook,
    key: "name" | "table" | "owner" | "state" | "where",
  ) => {
    if (key === "name") return hook.name;
    if (key === "table") return hook.table;
    if (key === "owner") return hook.owner;
    if (key === "state") return hook.on ? 1 : 0;
    return hook.kind === "webhook" ? hook.host : hook.lastRunAt;
  };
  const webhooks = sortRows(
    access.data?.webhooks ?? [],
    webhookSort.sort,
    hookValue,
    (hook) => hook.id,
  );
  const automations = sortRows(
    access.data?.automations ?? [],
    automationSort.sort,
    hookValue,
    (hook) => hook.id,
  );
  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: api.admin.access.hooks.queryKey(),
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
      {(
        [
          [
            "webhook",
            t`Webhooks`,
            webhooks,
            access.data?.webhooksTotal ?? 0,
            webhooksPage,
            t`No webhook.`,
            webhookSort,
          ],
          [
            "automation",
            t`Automations`,
            automations,
            access.data?.automationsTotal ?? 0,
            automationsPage,
            t`No automation.`,
            automationSort,
          ],
        ] as const
      ).map(([kind, title, list, total, pager, empty, columns]) => (
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
                    {columns.header("name", t`Name`, head)}
                    {columns.header("table", t`Table`, head)}
                    {columns.header("owner", t`Owner`, head)}
                    {columns.header("state", t`State`, head)}
                    {columns.header(
                      "where",
                      kind === "webhook" ? t`Sends to` : t`Last run`,
                      head,
                    )}
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
