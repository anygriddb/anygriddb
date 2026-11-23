import { Button, Input, Label, Spinner, Tooltip } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useCatalog } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { canManage } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { EmptyState, NotebookPage } from "../shell/notebook-page";
import { useWhen } from "../../lib/i18n";

export function DashboardList({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const when = useWhen();
  const errorText = useErrorText();
  const api = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === baseId);
  const manage = canManage(base?.role);
  const list = useQuery(api.dashboards.list.queryOptions({ baseId }));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The dashboard about to be deleted, once that is confirmed.
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(
    null,
  );

  if (!base) return null;

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await trpc.dashboards.create.mutate({
        baseId,
        name: name.trim(),
      });
      setName("");
      await queryClient.invalidateQueries({
        queryKey: api.dashboards.list.queryKey({ baseId }),
      });
      void navigate({
        to: "/b/$baseId/dashboards/$dashboardId",
        params: { baseId: baseId, dashboardId: created.id },
      });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const dashboards = list.data?.dashboards ?? [];

  return (
    <NotebookPage
      title={t`Dashboards of ${{ name: base.name }}`}
      description={t`Metrics, charts, and embedded views over this base’s tables.`}
    >
      {manage ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-2 border-b border-rule pb-7"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="flex min-w-60 flex-1 flex-col gap-1">
            <Label htmlFor="dashboard-name">{t`New dashboard`}</Label>
            <Input
              id="dashboard-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <Plus className="h-4 w-4" aria-hidden />}
            {t`Create`}
          </Button>
        </form>
      ) : null}
      {list.isLoading ? <Spinner className="mt-6" /> : null}
      {list.isError ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {!list.isLoading && !list.isError && dashboards.length === 0 ? (
        <EmptyState
          title={t`No dashboards yet.`}
          description={
            manage
              ? t`Create one to put metrics and charts on this base.`
              : undefined
          }
        />
      ) : null}
      {dashboards.length > 0 ? (
        <ul>
          {dashboards.map((dashboard) => (
            <li key={dashboard.id} className="border-b border-rule">
              <div className="flex min-h-12 items-center gap-3 text-sm">
                <Link
                  to="/b/$baseId/dashboards/$dashboardId"
                  params={{ baseId: baseId, dashboardId: dashboard.id }}
                  className="min-w-0 flex-1 font-medium hover:underline"
                >
                  {dashboard.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {when.instant(dashboard.updatedAt)}
                </span>
                {manage ? (
                  <Tooltip
                    content={t`Delete the dashboard ${{ name: dashboard.name }}`}
                  >
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t`Delete the dashboard ${{ name: dashboard.name }}`}
                      onClick={() =>
                        setRemoving({ id: dashboard.id, name: dashboard.name })
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </Tooltip>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {removing ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t`Delete the dashboard “${{ name: removing.name }}”?`}
          description={t`Its widgets go with it. A deleted dashboard cannot be brought back: the tables it reads keep their rows.`}
          confirmLabel={t`Delete`}
          onConfirm={async () => {
            try {
              await trpc.dashboards.delete.mutate({
                dashboardId: removing.id,
              });
              toast.success(t`Dashboard deleted`);
            } catch (cause) {
              toast.error(errorText(cause));
            }
            await queryClient.invalidateQueries({
              queryKey: api.dashboards.list.queryKey({ baseId }),
            });
          }}
        />
      ) : null}
    </NotebookPage>
  );
}
