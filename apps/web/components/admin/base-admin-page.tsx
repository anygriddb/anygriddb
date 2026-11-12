import { Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { formatBytes, formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useTRPC } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { LoadFailed } from "../shell/load-failed";

/**
 * One base in Administration (ROADMAP #14): its owners and members with
 * their roles, its tables with their weight, and its public links and
 * calendar feeds. Metadata only; roles change from each person's page.
 */
export function BaseAdminPage({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const api = useTRPC();
  const roleLabel = useRoleLabel();
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
  const { base, members, tables, links } = detail.data;
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
      </header>

      <section className="flex flex-col gap-2" aria-labelledby="base-members">
        <h3 id="base-members" className="text-sm font-semibold">
          {t`Members`}
        </h3>
        <div className="overflow-x-auto rounded-sm border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs">
              <tr>
                <th className={head}>{t`Account`}</th>
                <th className={head}>{t`Role`}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      to="/admin/people/accounts/$userId"
                      params={{ userId: member.userId }}
                      className="font-medium hover:underline"
                    >
                      {member.displayName}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {member.email}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {roleLabel(member.role)}
                    {member.groups.length > 0 ? (
                      <span className="block text-muted-foreground">
                        {t`Through ${{ groups: member.groups.join(", ") }}`}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
    </div>
  );
}
