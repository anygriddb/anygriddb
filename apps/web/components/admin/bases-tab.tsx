import { Button, Checkbox, Input, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { formatBytes, formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useTrashDays } from "../../lib/trash";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { useReadsAll } from "./admin-access";

type Trashed =
  RouterOutputs["admin"]["baseOverview"]["trashed"]["items"][number];

/**
 * Every base of the instance (ROADMAP #14, #22): its owners, members, tables,
 * estimated rows, files, and what of it leaves through a link or a feed;
 * the bases no active account owns, pointed out; and the bases in the
 * trash, whoever deleted them, restored from here. Metadata only: never a
 * cell value. A base opens its own page.
 */
export function BasesTab() {
  const { t } = useLingui();
  const { locale } = useLocale();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const days = useTrashDays();
  const readsAll = useReadsAll();
  const [search, setSearch] = useState("");
  const [asked, setAsked] = useState("");
  const [ownerlessOnly, setOwnerlessOnly] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const bases = useQuery({
    ...api.admin.baseOverview.list.queryOptions({
      search: asked || undefined,
      ownerless: ownerlessOnly || undefined,
    }),
    placeholderData: (previous) => previous,
  });
  const trashed = useQuery({
    ...api.admin.baseOverview.trashed.queryOptions(),
    enabled: readsAll,
  });
  const list = bases.data?.bases ?? [];
  const trashItems = trashed.data?.items ?? [];

  async function restore(entry: Trashed) {
    try {
      await trpc.admin.baseOverview.restore.mutate({ baseId: entry.id });
      await queryClient.invalidateQueries({
        queryKey: api.admin.baseOverview.pathKey(),
      });
      toast.success(t`Restored from the trash`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t`Row counts are the database's estimates: a table gets one once it has been analyzed.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          reads
          aria-label={t`Search bases`}
          placeholder={t`Search bases`}
          className="h-8 w-full text-sm md:w-72"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Checkbox
            reads
            checked={ownerlessOnly}
            onChange={(event) => setOwnerlessOnly(event.target.checked)}
          />
          {t`Without an active owner`}
        </label>
      </div>
      {bases.isLoading ? <Spinner /> : null}
      {bases.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(bases.error)}
        </p>
      ) : null}
      {bases.data && list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {asked || ownerlessOnly ? t`No base matches.` : t`No base yet.`}
        </p>
      ) : null}
      {list.length > 0 ? (
        <div className="overflow-x-auto rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs">
              <tr>
                <th className="px-3 py-2">{t`Base`}</th>
                <th className="px-3 py-2">{t`Owners`}</th>
                <th className="px-3 py-2 text-right">{t`Members`}</th>
                <th className="px-3 py-2 text-right">{t`Tables`}</th>
                <th className="px-3 py-2 text-right">{t`Rows, about`}</th>
                <th className="px-3 py-2 text-right">{t`Files`}</th>
                <th className="px-3 py-2 text-right">{t`Links and feeds`}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((base) => (
                <tr key={base.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">
                    <Link
                      to="/admin/bases/$baseId"
                      params={{ baseId: base.id }}
                      className="hover:underline"
                    >
                      {base.name}
                    </Link>
                    {!base.hasLiveOwner ? (
                      <span className="mt-0.5 block text-xs text-warning">
                        {t`No active owner`}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {base.owners.length > 0 ? base.owners.join(", ") : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatNumber(base.members, locale)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatNumber(base.tables, locale)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatNumber(base.estimatedRows, locale)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatBytes(base.fileBytes)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatNumber(base.outbound, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {trashItems.length > 0 ? (
        <section aria-label={t`Deleted bases`} className="mt-6">
          <h3 className="text-sm font-semibold">{t`Deleted bases`}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t`They stay for ${{ days }} days with their data, then are deleted permanently.`}
          </p>
          <ul className="mt-2 divide-y divide-border rounded-sm border border-border">
            {trashItems.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{entry.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t`deleted on ${{ date: new Date(entry.deletedAt).toLocaleDateString() }} by ${{ name: entry.deletedBy ?? t`a deleted account` }}`}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void restore(entry)}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  {t`Restore`}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
