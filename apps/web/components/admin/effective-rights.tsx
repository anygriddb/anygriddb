import { Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useWhen } from "../../lib/i18n";
import { useTRPC, type RouterOutputs } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { LoadFailed } from "../shell/load-failed";
import { usePermissionFamilies } from "./permission-labels";

type Effective = RouterOutputs["admin"]["access"]["effective"];
type Origin = Effective["origins"][number];
type Held = Pick<Effective, "origins" | "permissions">;

/** One attribution in a few words: its role, whose it is, until when. */
function useOriginLabel() {
  const { t } = useLingui();
  const roleLabel = useRoleLabel();
  const when = useWhen();
  return (origin: Origin): string =>
    [
      origin.madeName ?? roleLabel(origin.role),
      origin.group ? t`group ${{ name: origin.group.name }}` : t`own role`,
      ...(origin.scope === "table" ? [t`on the table`] : []),
      ...(origin.endsAt ? [t`until ${{ date: when.day(origin.endsAt) }}`] : []),
      ...(origin.narrows ? [t`with a rule`] : []),
    ].join(" · ");
}

/** Each permission held, by family, with the attributions that give it. */
function Permissions({ held }: { held: Held }) {
  const { t } = useLingui();
  const families = usePermissionFamilies();
  const originLabel = useOriginLabel();
  const from = new Map(
    held.permissions.map((one) => [one.permission, one.from]),
  );
  return (
    <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,12rem)_1fr]">
      {families.flatMap((family) =>
        family.permissions.flatMap(({ permission, label }) => {
          const givers = from.get(permission);
          if (!givers) return [];
          return [
            <div key={permission} className="contents">
              <dt className="font-medium">{label}</dt>
              <dd className="text-muted-foreground">
                {givers
                  .map((index) => {
                    const origin = held.origins[index];
                    return origin ? originLabel(origin) : "";
                  })
                  .join(t`; `)}
              </dd>
            </div>,
          ];
        }),
      )}
    </dl>
  );
}

/** What a table's rules keep from its reader, in a few words. */
function useNarrowedLabel() {
  const { t } = useLingui();
  return (
    narrowed: { rows: boolean; fields: boolean } | null,
  ): string | null => {
    if (!narrowed) return null;
    if (narrowed.rows && narrowed.fields) return t`Some rows and fields only`;
    return narrowed.rows ? t`Some rows only` : t`Some fields only`;
  };
}

/**
 * Every permission an account holds on one base and each of its tables,
 * and the attributions it comes from: its own or a group's, on the base or
 * the table, until when, with a rule or not (ROADMAP #29, ADR 0131).
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
  const originLabel = useOriginLabel();
  const narrowedLabel = useNarrowedLabel();
  const rights = useQuery(
    api.admin.access.effective.queryOptions({ userId, baseId }),
  );

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
      </p>
      {data.origins.length > 0 ? (
        <>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {data.origins.map((origin, index) => (
              <li key={index}>{originLabel(origin)}</li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer">{t`Permissions on the base, and what gives each`}</summary>
            <div className="pt-1">
              <Permissions held={data} />
            </div>
          </details>
        </>
      ) : null}
      {data.tables.length === 0 ? (
        <p className="text-muted-foreground">{t`No table in this base.`}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-sm border border-border bg-background">
          {data.tables.map((table) => {
            const narrowed = narrowedLabel(table.narrowed);
            const own = table.overridden || narrowed !== null;
            return (
              <li key={table.tableId} className="px-2 py-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">
                    {table.tableName}
                  </span>
                  <span className="text-muted-foreground">
                    {table.role ? roleLabel(table.role) : t`No access`}
                    {table.overridden
                      ? ` · ${t`Adds a role on the table`}`
                      : null}
                    {narrowed ? ` · ${narrowed}` : null}
                    {own ? null : ` · ${t`As on the base`}`}
                  </span>
                </div>
                {own && table.origins.length > 0 ? (
                  <details className="pt-1">
                    <summary className="cursor-pointer text-muted-foreground">{t`Permissions on this table, and what gives each`}</summary>
                    <div className="pt-1">
                      <Permissions held={table} />
                    </div>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
