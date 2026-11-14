import { Button, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { formatNumber } from "../../lib/format";
import { useFormatBytes } from "../../lib/format-bytes";
import { useLocale } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { useTrashDays } from "../../lib/trash";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { BaseAdminMembers } from "./base-admin-members";
import { OpenBase } from "./open-base";

/**
 * One base in Administration (ROADMAP #14, #69, #22): its members, whose
 * roles are given, changed, and taken away from here; its tables with
 * their weight; its public links and calendar feeds; and the base itself
 * put in the trash. Metadata only: never a cell value.
 */
export function BaseAdminPage({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const formatBytes = useFormatBytes();
  const { locale } = useLocale();
  const api = useTRPC();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const days = useTrashDays();
  const isAdmin = useSession().data?.isAdmin === true;
  const [trashing, setTrashing] = useState(false);
  const detail = useQuery(api.admin.baseOverview.get.queryOptions({ baseId }));
  const back = (
    <Link
      to="/admin/bases"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {t`Bases`}
    </Link>
  );
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <LoadFailed
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }
  if (!detail.data) return <Spinner />;
  const { base, members, tables, links, open } = detail.data;
  const head = "px-3 py-2";
  return (
    <div className="flex flex-col gap-5">
      {back}
      <header>
        <h2 className="text-lg font-semibold">{base.name}</h2>
        <p className="text-sm text-muted-foreground">
          {t`Created ${{ when: new Date(base.createdAt).toLocaleDateString() }}`}{" "}
          · {formatBytes(base.fileBytes)}
        </p>
        {!base.hasLiveOwner ? (
          <p className="mt-2 rounded-sm border border-warning/40 bg-warning-surface px-3 py-2 text-sm">
            {t`No active account owns this base, itself or through a group: nobody can manage it. Give someone the owner role below.`}
          </p>
        ) : null}
      </header>

      <BaseAdminMembers
        baseId={baseId}
        baseName={base.name}
        members={members}
      />

      <OpenBase baseId={baseId} members={members} open={open} />

      <section className="flex flex-col gap-2" aria-labelledby="base-tables">
        <h3 id="base-tables" className="text-sm font-semibold">
          {t`Tables`}
        </h3>
        {tables.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t`No table.`}</p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs">
                <tr>
                  <th className={head}>{t`Table`}</th>
                  <th className={`${head} text-right`}>{t`Rows, about`}</th>
                  <th className={`${head} text-right`}>{t`Files`}</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((table) => (
                  <tr key={table.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      {table.name}
                      {table.external ? (
                        <span className="block text-xs text-muted-foreground">
                          {t`In a client's database`}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      {table.estimatedRows === null
                        ? "—"
                        : formatNumber(table.estimatedRows, locale)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      {formatBytes(table.fileBytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="base-links">
        <h3 id="base-links" className="text-sm font-semibold">
          {t`Links and feeds`}
        </h3>
        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t`Nothing of this base can be read from outside it.`}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-sm border border-border text-sm">
            {links.map((link) => (
              <li
                key={`${link.kind}:${link.id}`}
                className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"
              >
                <span>
                  {link.kind === "link" ? t`Public link` : t`Calendar feed`} ·{" "}
                  {link.table} · {link.view}
                </span>
                <span className="text-xs text-muted-foreground">
                  {link.author}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link
          to="/admin/sharing"
          className="w-fit text-sm text-primary hover:underline"
        >
          {t`Revoke from Sharing`}
        </Link>
      </section>

      {isAdmin ? (
        <section className="flex flex-col gap-2" aria-labelledby="base-trash">
          <h3 id="base-trash" className="text-sm font-semibold">
            {t`Delete this base`}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t`It goes to the trash for ${{ days }} days with its data, where its owners and administrators can restore it, then it is deleted permanently.`}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setTrashing(true)}
          >
            <Trash2 className="h-3.5 w-3.5 text-danger" aria-hidden />
            {t`Move to the trash`}
          </Button>
        </section>
      ) : null}
      {trashing ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setTrashing(false)}
          title={t`Move “${{ name: base.name }}” to the trash?`}
          description={t`Its members lose it at once. It stays in the trash for ${{ days }} days with its data, then is deleted permanently.`}
          confirmLabel={t`Move to the trash`}
          onConfirm={async () => {
            try {
              await trpc.admin.baseOverview.trash.mutate({ baseId });
              await queryClient.invalidateQueries({
                queryKey: api.admin.baseOverview.pathKey(),
              });
              toast.success(t`Moved to the trash`);
              await navigate({ to: "/admin/bases" });
            } catch (cause) {
              toast.error(errorText(cause));
              throw cause;
            }
          }}
        />
      ) : null}
    </div>
  );
}
