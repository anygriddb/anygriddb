import { Input, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useErrorText } from "../../lib/errors";
import { formatBytes, formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useTRPC } from "../../lib/trpc";

/**
 * Every base of the instance (ROADMAP #14): its owners, members, tables,
 * estimated rows, files, and what of it leaves through a link or a feed.
 * Metadata only: never a cell value. A base opens its own page.
 */
export function BasesTab() {
  const { t } = useLingui();
  const { locale } = useLocale();
  const errorText = useErrorText();
  const api = useTRPC();
  const [search, setSearch] = useState("");
  const [asked, setAsked] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setAsked(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const bases = useQuery({
    ...api.admin.baseOverview.list.queryOptions({
      search: asked || undefined,
    }),
    placeholderData: (previous) => previous,
  });
  const list = bases.data?.bases ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t`Row counts are the database's estimates: a table gets one once it has been analyzed.`}
      </p>
      <Input
        aria-label={t`Search bases`}
        placeholder={t`Search bases`}
        className="h-8 w-full text-sm md:w-72"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {bases.isLoading ? <Spinner /> : null}
      {bases.error ? (
        <p role="alert" className="text-sm text-danger">
          {errorText(bases.error)}
        </p>
      ) : null}
      {bases.data && list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {asked ? t`No base matches.` : t`No base yet.`}
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
    </div>
  );
}
