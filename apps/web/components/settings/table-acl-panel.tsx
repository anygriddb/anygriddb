import { Button, Select, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Shield } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import type { CatalogColumn } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

type Access = "hide" | "read" | "write";

/** Per-member field access and a “view as” preview for one table. */
export function TableAclPanel(props: {
  tableId: string;
  columns: CatalogColumn[];
  people: Array<{ id: string; displayName: string; email?: string }>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const rules = useQuery(
    api.catalog.tableAcl.queryOptions({ tableId: props.tableId }),
  );
  const [userId, setUserId] = useState(props.people[0]?.id ?? "");
  const [viewAs, setViewAs] = useState<string | null>(null);
  const preview = useQuery({
    ...api.catalog.viewAs.queryOptions({
      tableId: props.tableId,
      userId: viewAs ?? userId,
      limit: 5,
    }),
    enabled: Boolean(viewAs),
  });

  const current = rules.data?.rules.find((rule) => rule.userId === userId);
  const [access, setAccess] = useState<Record<string, Access>>({});
  const map =
    Object.keys(access).length > 0
      ? access
      : Object.fromEntries(
          props.columns.map((column) => [
            column.name,
            current?.columns.find((rule) => rule.column === column.name)
              ?.access ?? "write",
          ]),
        );

  async function save() {
    try {
      await trpc.catalog.setTableAcl.mutate({
        tableId: props.tableId,
        userId,
        rowFilter: current?.rowFilter ?? null,
        columns: Object.entries(map).map(([column, value]) => ({
          column,
          access: value,
        })),
      });
      setAccess({});
      await queryClient.invalidateQueries({
        queryKey: api.catalog.tableAcl.queryKey({ tableId: props.tableId }),
      });
      toast.success(t`Permissions saved`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function clear() {
    try {
      await trpc.catalog.clearTableAcl.mutate({
        tableId: props.tableId,
        userId,
      });
      setAccess({});
      await queryClient.invalidateQueries({
        queryKey: api.catalog.tableAcl.queryKey({ tableId: props.tableId }),
      });
      toast.success(t`Restrictions cleared`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  if (props.people.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t`Invite members to set fine-grained permissions.`}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Shield className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">{t`Field permissions`}</span>
        <Select
          className="ml-auto w-56"
          value={userId}
          onChange={(event) => {
            setUserId(event.target.value);
            setAccess({});
            setViewAs(null);
          }}
        >
          {props.people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.displayName}
            </option>
          ))}
        </Select>
        <Button size="xs" variant="outline" onClick={() => setViewAs(userId)}>
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {t`View as`}
        </Button>
      </div>
      {rules.isLoading ? <Spinner /> : null}
      <ul className="divide-y divide-border text-sm">
        {props.columns.map((column) => (
          <li key={column.name} className="flex items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 truncate">{column.label}</span>
            <Select
              className="h-8 w-36"
              value={map[column.name] ?? "write"}
              onChange={(event) =>
                setAccess({
                  ...map,
                  [column.name]: event.target.value as Access,
                })
              }
            >
              <option value="write">{t`Read and write`}</option>
              <option value="read">{t`Read only`}</option>
              <option value="hide">{t`Hidden`}</option>
            </Select>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void save()}>
          {t`Save`}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void clear()}>
          {t`Clear restrictions`}
        </Button>
      </div>
      {viewAs ? (
        <div className="rounded-md border border-primary/30 bg-accent/30 p-3 text-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-medium">
              {t`Preview: ${{ name: preview.data?.user.displayName ?? "…" }}`}
            </p>
            <Button size="xs" variant="ghost" onClick={() => setViewAs(null)}>
              {t`Close`}
            </Button>
          </div>
          {preview.isLoading ? <Spinner /> : null}
          {preview.data ? (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <p>
                {t`Role: ${{ role: preview.data.role }}`} ·{" "}
                {t`${{ count: preview.data.sample.total }} visible rows`}
              </p>
              <p>
                {t`Visible fields: ${{
                  fields:
                    preview.data.columns
                      .filter((column) => column.access !== "hide")
                      .map((column) => column.name)
                      .join(", ") || "—",
                }}`}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
