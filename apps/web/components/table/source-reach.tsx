/**
 * When the operator's allow list no longer covers a source's host: banners
 * on tables, bases, and dashboards. Objects stay visible; they are marked
 * unavailable or as reading a frozen copy.
 */
import { isCopySourceEngine } from "@anygriddb/core";
import { cn } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ShieldAlert } from "lucide-react";
import { formatInstant } from "../../lib/format";
import type { CatalogTable } from "../../lib/types";

/** Tables whose source host is outside ANYGRIDDB_SOURCES_ALLOWED_HOSTS. */
export function blockedSourceTables(
  tables: readonly CatalogTable[],
): CatalogTable[] {
  return tables.filter(
    (table) => table.external !== null && !table.external.hostAllowed,
  );
}

/** Note under a table header: live refuse, or synced copy frozen. */
export function CopyNote({
  external,
  locale,
}: {
  external: NonNullable<CatalogTable["external"]>;
  locale: "fr" | "en";
}) {
  const { t } = useLingui();
  const synced = external.synced;

  if (!external.hostAllowed) {
    if (synced) {
      return (
        <p
          role="status"
          className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs text-foreground"
        >
          <ShieldAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
            aria-hidden
          />
          <span>
            {synced.at
              ? t`This source's host is not allowed: reading the copy from ${{
                  date: formatInstant(synced.at, locale),
                }}. Refresh is paused until the operator allows the host.`
              : t`This source's host is not allowed: the copy cannot refresh until the operator allows the host.`}
          </span>
        </p>
      );
    }
    return (
      <p
        role="alert"
        className="flex items-start gap-2 border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-xs text-foreground"
      >
        <ShieldAlert
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
          aria-hidden
        />
        <span>
          {t`This source's host is not allowed: the operator must add it to ANYGRIDDB_SOURCES_ALLOWED_HOSTS. Rows cannot be read or written in the client's database.`}
        </span>
      </p>
    );
  }

  if (!synced) return null;
  return (
    <p
      role="note"
      className="border-b border-border bg-head px-4 py-1 text-xs text-muted-foreground"
    >
      {synced.at
        ? t`Copy of the client's database from ${{
            date: formatInstant(synced.at, locale),
          }}, refreshed every ${{ minutes: synced.intervalMinutes }} min: read-only`
        : isCopySourceEngine(external.engine)
          ? t`The copy has not arrived. The table stays empty until then.`
          : t`Copy in preparation: the table is read live until then`}
    </p>
  );
}

/**
 * Banner for a base or a dashboard that still lists tables whose source
 * host is blocked. Does not hide those objects.
 */
export function BlockedSourcesBanner({
  tables,
  locale,
  surface,
}: {
  tables: readonly CatalogTable[];
  locale: "fr" | "en";
  surface: "base" | "dashboard";
}) {
  const { t } = useLingui();
  const blocked = blockedSourceTables(tables);
  if (blocked.length === 0) return null;

  const live = blocked.filter((table) => table.external?.synced == null);
  const synced = blocked.filter((table) => table.external?.synced != null);
  const oldest = synced.reduce<string | null>((best, table) => {
    const at = table.external?.synced?.at ?? null;
    if (!at) return best;
    if (best === null || at < best) return at;
    return best;
  }, null);

  const where =
    surface === "dashboard"
      ? t`This dashboard uses tables whose source host is not allowed.`
      : t`This base has tables whose source host is not allowed.`;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm",
        surface === "base" && "mt-4",
      )}
    >
      <ShieldAlert
        className="mt-0.5 h-4 w-4 shrink-0 text-warning"
        aria-hidden
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p>{where}</p>
        {live.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {plural(live.length, {
              one: `# live table cannot reach the client's database until the operator allows its host.`,
              other: `# live tables cannot reach the client's database until the operator allows their hosts.`,
            })}
          </p>
        ) : null}
        {synced.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {oldest
              ? t`Synced tables still show their copies (oldest from ${{
                  date: formatInstant(oldest, locale),
                }}); refresh is paused.`
              : plural(synced.length, {
                  one: `# synced table keeps its copy; refresh is paused until the operator allows the host.`,
                  other: `# synced tables keep their copies; refresh is paused until the operator allows their hosts.`,
                })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
