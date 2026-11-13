import type { PickerOption } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc";

/** An account an administrator may give a base role to. */
export type AccountChoice = {
  id: string;
  displayName: string;
  email: string;
};

/**
 * Active accounts whose name or address holds what is typed, as options of
 * a list picker (ROADMAP #69).
 */
export function useAccountChoices(typed: string, enabled: boolean) {
  const { t } = useLingui();
  const api = useTRPC();
  const users = useQuery({
    ...api.admin.users.queryOptions({
      search: typed.trim() || undefined,
      status: "active",
      sort: "name",
      direction: "asc",
      offset: 0,
      limit: 50,
    }),
    enabled,
    placeholderData: keepPreviousData,
  });
  const found: AccountChoice[] = (users.data?.users ?? []).map((user) => ({
    id: user.id,
    displayName: user.displayName,
    email: user.email,
  }));
  const options: PickerOption[] = found.map((account) => ({
    id: account.id,
    textValue: t`${{ name: account.displayName }} (${{ email: account.email }})`,
    children: <AccountName name={account.displayName} email={account.email} />,
  }));
  return { found, options, loading: users.isLoading };
}

/** An account's name, and its address under it. */
export function AccountName({ name, email }: { name: string; email: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm">{name}</span>
      <span className="truncate text-xs text-muted-foreground">{email}</span>
    </span>
  );
}
