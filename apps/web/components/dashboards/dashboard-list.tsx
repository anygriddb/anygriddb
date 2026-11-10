import { Button, Input, Label, Spinner } from "@anygriddb/ui";
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
import { EmptyState, NotebookPage } from "../shell/notebook-page";

export function DashboardList({ baseId }: { baseId: string }) {
  const { t } = useLingui();
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
      {!list.isLoading && dashboards.length === 0 ? (
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
                  {new Date(dashboard.updatedAt).toLocaleString()}
                </span>
                {manage ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t`Delete`}
                    onClick={() => {
                      void (async () => {
                        try {
                          await trpc.dashboards.delete.mutate({
                            dashboardId: dashboard.id,
                          });
                          await queryClient.invalidateQueries({
                            queryKey: api.dashboards.list.queryKey({ baseId }),
                          });
                          toast.success(t`Dashboard deleted`);
                        } catch (cause) {
                          toast.error(errorText(cause));
                        }
                      })();
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </NotebookPage>
  );
}
