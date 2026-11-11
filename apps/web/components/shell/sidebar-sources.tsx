import { cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Server, Table2 } from "lucide-react";
import { useState } from "react";
import { ENGINE_NAMES } from "../../lib/limits";
import { sourcesOf } from "../../lib/sources";
import type { CatalogBase } from "../../lib/types";

/**
 * The databases the person's tables live in, by the name an administrator
 * gave each one, and those tables under it, whichever base holds them.
 * Shown when one of the person's tables is a client's.
 */
export function SidebarSources({ bases }: { bases: readonly CatalogBase[] }) {
  const { t } = useLingui();
  const params = useParams({ strict: false });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const sources = sourcesOf(bases);
  if (sources.length === 0) return null;
  return (
    <section aria-label={t`Sources`} className="mt-4">
      <span className="mb-1 block px-1 text-xs font-medium text-muted-foreground">
        {t`Sources`}
      </span>
      <ul className="flex flex-col gap-0.5">
        {sources.map((source) => {
          const open = expanded.has(source.id);
          const engine =
            (ENGINE_NAMES as Record<string, string>)[source.engine] ??
            source.engine;
          return (
            <li key={source.id}>
              <button
                type="button"
                aria-expanded={open}
                className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm hover:bg-muted"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(source.id)) next.delete(source.id);
                    else next.add(source.id);
                    return next;
                  })
                }
              >
                <span className="p-0.5 text-muted-foreground">
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  )}
                </span>
                <Server className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-left">
                  {source.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {engine}
                </span>
              </button>
              {open ? (
                <ul className="ml-5 flex flex-col gap-0.5 border-l border-border pl-2">
                  {source.tables.map((table) => (
                    <li key={table.tableId}>
                      <Link
                        to="/b/$baseId/t/$tableId/{-$viewId}"
                        params={{
                          baseId: table.baseId,
                          tableId: table.tableId,
                        }}
                        title={table.stored}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted",
                          params.tableId === table.tableId &&
                            "bg-accent text-accent-foreground",
                        )}
                      >
                        <Table2
                          className="h-3.5 w-3.5 shrink-0 opacity-70"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {table.name}
                        </span>
                        <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                          {table.baseName}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
