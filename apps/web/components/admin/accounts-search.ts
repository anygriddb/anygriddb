import { z } from "zod";

/** Accounts per page of the list. */
export const ACCOUNTS_PAGE = 50;

/**
 * The accounts list's filters, sort, and page as the address keeps them
 * (ROADMAP #49), so a filtered list can be shared and come back. A value
 * the list does not know is dropped, never an error.
 */
export const accountsSearchSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.enum(["active", "disabled", "locked"]).optional().catch(undefined),
  admin: z.enum(["yes", "no"]).optional().catch(undefined),
  mfa: z.enum(["yes", "no"]).optional().catch(undefined),
  origin: z.enum(["local", "sso", "scim"]).optional().catch(undefined),
  sort: z
    .enum(["name", "email", "created", "lastSeen"])
    .optional()
    .catch(undefined),
  dir: z.enum(["asc", "desc"]).optional().catch(undefined),
  page: z.coerce.number().int().min(2).max(20_000).optional().catch(undefined),
});

export type AccountsSearch = z.infer<typeof accountsSearchSchema>;

function flag(value: "yes" | "no" | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "yes";
}

/** What `admin.users` is asked for the address's filters. */
export function usersQuery(search: AccountsSearch) {
  return {
    search: search.q || undefined,
    status: search.status,
    admin: flag(search.admin),
    mfa: flag(search.mfa),
    origin: search.origin,
    sort: search.sort ?? "created",
    direction: search.dir ?? "asc",
    offset: ((search.page ?? 1) - 1) * ACCOUNTS_PAGE,
    limit: ACCOUNTS_PAGE,
  };
}

/** Whether any filter narrows the list (an empty list then says so). */
export function filtered(search: AccountsSearch): boolean {
  return Boolean(
    search.q || search.status || search.admin || search.mfa || search.origin,
  );
}

/**
 * The address after one change: a new filter goes back to the first page,
 * and a value left empty or at its default leaves the address.
 */
export function nextSearch(
  current: AccountsSearch,
  patch: Partial<AccountsSearch>,
): AccountsSearch {
  const merged: AccountsSearch = {
    ...current,
    ...patch,
    page: "page" in patch ? patch.page : undefined,
  };
  const next: AccountsSearch = {};
  if (merged.q) next.q = merged.q;
  if (merged.status) next.status = merged.status;
  if (merged.admin) next.admin = merged.admin;
  if (merged.mfa) next.mfa = merged.mfa;
  if (merged.origin) next.origin = merged.origin;
  if (merged.sort && merged.sort !== "created") next.sort = merged.sort;
  if (merged.dir === "desc") next.dir = merged.dir;
  if (merged.page && merged.page > 1) next.page = merged.page;
  return next;
}

/** Clicking a column's header: sorts by it, then turns the order round. */
export function sortSearch(
  current: AccountsSearch,
  sort: NonNullable<AccountsSearch["sort"]>,
): AccountsSearch {
  const active = (current.sort ?? "created") === sort;
  const dir = active && (current.dir ?? "asc") === "asc" ? "desc" : "asc";
  return nextSearch(current, { sort, dir });
}
