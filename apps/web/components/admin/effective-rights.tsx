import { Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useTRPC, type RouterOutputs } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { LoadFailed } from "../shell/load-failed";

type Effective = RouterOutputs["admin"]["access"]["effective"];
type Origin = Effective["origin"];

/**
 * Resolved role on one base and each of its tables, with whether it comes
 * from the person's own binding or a group (ROADMAP #29).
 */
export function EffectiveRights({
  userId,
  baseId,
}: {
  userId: string;
  baseId: string;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const roleLabel = useRoleLabel();
  const rights = useQuery(
    api.admin.access.effective.queryOptions({ userId, baseId }),
  );

  function originOf(origin: Origin): string {
    if (origin.kind === "direct") return t`Own role`;
    if (origin.kind === "group") return t`Group ${{ name: origin.groupName }}`;
    return t`None`;
  }

  if (rights.isError) {
    return (
      <LoadFailed error={rights.error} onRetry={() => void rights.refetch()} />
    );
  }
  if (!rights.data) {
    return (
      <div className="flex justify-center py-2">
        <Spinner />
      </div>
    );
  }

  const data = rights.data;
  return (
    <div className="flex flex-col gap-2 border-t border-border bg-muted/30 px-3 py-2 text-xs">
      <p>
        <span className="font-medium">{t`On the base`}</span>
        {": "}
        {data.role ? roleLabel(data.role) : t`No access`}
        {" · "}
        <span className="text-muted-foreground">{originOf(data.origin)}</span>
      </p>
      {data.tables.length === 0 ? (
        <p className="text-muted-foreground">{t`No table in this base.`}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-sm border border-border bg-background">
          {data.tables.map((table) => (
            <li
              key={table.tableId}
              className="flex flex-wrap items-baseline justify-between gap-2 px-2 py-1.5"
            >
              <span className="min-w-0 truncate font-medium">
                {table.tableName}
              </span>
              <span className="text-muted-foreground">
                {table.role ? roleLabel(table.role) : t`No access`}
                {" · "}
                {table.overridden ? `${t`Table override`} · ` : null}
                {originOf(table.origin)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
