import type { Permission } from "@anygriddb/core";
import { Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useTRPC, type RouterOutputs } from "../../lib/trpc";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import { AdminPager } from "./admin-list";
import { useAdminPage, useAdminPageSize } from "./admin-page-size";
import { usePermissionFamilies } from "./permission-labels";

type Review = RouterOutputs["admin"]["access"]["rightsReview"];
type Line = Review["lines"][number];
type Kind = Line["kind"];

const KINDS: readonly Kind[] = [
  "manager",
  "group",
  "ruled",
  "floor",
  "base_only",
  "idle_rule",
];

/**
 * What the next minor version, where roles add up (ADR 0131), will not
 * keep exactly, read with this one: whose access changes, where, and how,
 * so that an administrator can change it first or accept it. The upgrade
 * itself counts the same cases and refuses until they are accepted.
 */
export function RightsReviewTab() {
  const { t } = useLingui();
  const api = useTRPC();
  const families = usePermissionFamilies();
  const [pageSize, setPageSize] = useAdminPageSize();
  const page = useAdminPage(pageSize);
  const review = useQuery({
    ...api.admin.access.rightsReview.queryOptions({
      limit: pageSize,
      offset: page.offset,
    }),
    placeholderData: (previous) => previous,
  });

  const label = new Map(
    families.flatMap((family) =>
      family.permissions.map((item) => [item.permission, item.label] as const),
    ),
  );
  const named = (permissions: readonly Permission[]) =>
    permissions.map((permission) => label.get(permission) ?? permission);

  const kindName: Record<Kind, string> = {
    manager: t`Table widens to the base`,
    group: t`Table widens to the group's role`,
    ruled: t`Role on each table instead of the base`,
    floor: t`Base role lowered`,
    base_only: t`Lost on the base`,
    idle_rule: t`Rule that binds nobody`,
  };

  function said(line: Line): string {
    const list = named(line.permissions).join(", ");
    switch (line.kind) {
      case "manager":
        return line.permissions.length > 0
          ? t`They manage the base, so their role there stays; on this table, where a role gave them less, they will also hold: ${list}.`
          : t`They manage the base, so their role there stays; on this table their field and row rule will no longer apply.`;
      case "group":
        return line.permissions.length > 0
          ? t`A group gives them a role on the base, which a table's role cannot take away: on this table they will also hold: ${list}.`
          : t`A group gives them a role on the base, which a rule cannot narrow: on this table their field and row rule will no longer apply.`;
      case "ruled":
        return t`Their role on the base is replaced by a role on each of its tables, with the same rights and rules as now. A table made after the upgrade is not open to them until someone gives it.`;
      case "floor":
        return t`Their role on the base becomes what it shares with the tables where they hold less (${list}), and each table keeps exactly what they hold now. A table made after the upgrade gives them that lower role.`;
      case "base_only":
        return t`What only the base gives (making tables and folders, dashboards, importing a workbook, publishing the base) is lost there: ${list}.`;
      case "idle_rule":
        return t`A field or row rule on someone who manages the table, or has no access to it, has no effect now and is removed.`;
    }
  }

  if (review.isError) {
    return (
      <LoadFailed error={review.error} onRetry={() => void review.refetch()} />
    );
  }
  if (!review.data) return <Spinner />;

  const data = review.data;
  return (
    <RuledSection
      title={t`Rights to review`}
      description={t`From the next minor version, roles add up: a role given on a table only adds to what the base gives, and a field or row rule narrows only the role it comes with. Everyone keeps exactly what they hold on every existing table, except in the cases below. The upgrade counts them and stops until an operator accepts them; to avoid one, change the roles or rules it names before upgrading.`}
    >
      <div className="flex flex-col gap-4">
        {data.total === 0 ? (
          <p className="text-sm">{t`Nothing to review: everyone's access will stay exactly as it is.`}</p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {KINDS.filter((kind) => data.counts[kind] > 0).map((kind) => (
                <li key={kind}>
                  <span className="font-medium">{kindName[kind]}</span>
                  {": "}
                  {plural(data.counts[kind], {
                    one: "# case",
                    other: "# cases",
                  })}
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-border rounded-sm border border-border text-sm">
              {data.lines.map((line) => (
                <li
                  key={`${line.kind}:${line.person.id}:${line.base.id}:${line.table?.id ?? ""}`}
                  className="flex flex-col gap-1 px-3 py-2"
                >
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{line.person.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {line.person.email}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t`Base`}
                    {": "}
                    {line.base.name}
                    {line.base.trashed ? ` (${t`In the trash`})` : ""}
                    {" · "}
                    {t`Table`}
                    {": "}
                    {line.table
                      ? `${line.table.name}${line.table.trashed ? ` (${t`In the trash`})` : ""}`
                      : t`Every table`}
                  </p>
                  <p>
                    <span className="font-medium">{kindName[line.kind]}</span>
                    {". "}
                    {said(line)}
                  </p>
                </li>
              ))}
            </ul>
            <AdminPager
              total={data.total}
              offset={page.offset}
              pageSize={pageSize}
              onPageSize={setPageSize}
              onPrev={() => page.setPage(page.page - 1)}
              onNext={() => page.setPage(page.page + 1)}
            />
          </>
        )}
      </div>
    </RuledSection>
  );
}
