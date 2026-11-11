import type { PickerOption } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc";

/** A base an administrator may give a role on, with its owners' names. */
export type BaseChoice = { id: string; name: string; owners: string[] };

/**
 * The instance's live bases whose name holds what is typed, found on the
 * server (ADR 0057), as options of a list picker: each shows its owners,
 * so two bases of one name are told apart.
 */
export function useBaseChoices(typed: string, enabled: boolean) {
  const { t } = useLingui();
  const api = useTRPC();
  const bases = useQuery({
    ...api.admin.bases.list.queryOptions({
      search: typed.trim() || undefined,
      limit: 50,
    }),
    enabled,
    placeholderData: keepPreviousData,
  });
  const found: BaseChoice[] = bases.data?.bases ?? [];
  const options: PickerOption[] = found.map((base) => {
    const owners = base.owners.join(", ");
    return {
      id: base.id,
      textValue: owners
        ? t`${{ base: base.name }}, owned by ${{ owners }}`
        : base.name,
      children: <BaseName name={base.name} owners={owners} />,
    };
  });
  return { found, options, loading: bases.isLoading };
}

/** A base's name, and who owns it under it. */
export function BaseName({ name, owners }: { name: string; owners: string }) {
  const { t } = useLingui();
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm">{name}</span>
      {owners ? (
        <span className="truncate text-xs text-muted-foreground">
          {t`Owned by ${{ owners }}`}
        </span>
      ) : null}
    </span>
  );
}
