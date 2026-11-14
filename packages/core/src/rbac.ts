export type Scope = "base" | "table" | "row" | "column";

/**
 * `read` rows, `comment` on rows, `write` rows, `manage` the schema,
 * sharing, and integrations.
 */
export type Action = "read" | "comment" | "write" | "manage";

export const ROLES = ["owner", "editor", "commenter", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Binding = {
  role: Role;
  scope: Scope;
  scopeId: string;
};

const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};

const ACTION_RANK: Record<Action, number> = {
  read: 1,
  comment: 2,
  write: 3,
  manage: 4,
};

export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

export function roleAllows(role: Role | null, action: Action): boolean {
  return role !== null && ROLE_RANK[role] >= ACTION_RANK[action];
}

/** Highest role bound to this exact scope, if any. */
export function roleFor(
  bindings: readonly Binding[],
  scope: Scope,
  scopeId: string,
): Role | null {
  let best: Role | null = null;
  for (const binding of bindings) {
    if (binding.scope !== scope || binding.scopeId !== scopeId) {
      continue;
    }
    if (!best || ROLE_RANK[binding.role] > ROLE_RANK[best]) {
      best = binding.role;
    }
  }
  return best;
}

/**
 * Role on a table: a binding on the table itself overrides, otherwise the
 * role on its base applies. A table override may grant less than the base.
 */
export function effectiveTableRole(
  bindings: readonly Binding[],
  tableId: string,
  baseId: string | undefined,
): Role | null {
  const own = roleFor(bindings, "table", tableId);
  if (own) {
    return own;
  }
  return baseId ? roleFor(bindings, "base", baseId) : null;
}

/**
 * Whether the bindings allow `action`. For a table, pass its `baseId` so
 * the base role applies when the table has no override.
 */
export function can(
  bindings: readonly Binding[],
  action: Action,
  scope: Scope,
  scopeId: string,
  baseId?: string,
): boolean {
  const role =
    scope === "table"
      ? effectiveTableRole(bindings, scopeId, baseId)
      : roleFor(bindings, scope, scopeId);
  return roleAllows(role, action);
}

/**
 * Who must confirm a second factor before working (ADR 0043):
 * administrators always; then, as the instance chooses, owners and anyone
 * creating a base (the default), every account, or nobody else. An
 * account the identity provider vouches for (`providerFactor`) counts as
 * enrolled.
 */
export function enrollmentGate(input: {
  bindings: readonly Binding[];
  factors: number;
  creatingBase?: boolean;
  isAdmin: boolean;
  scope: "admins" | "owners" | "everyone";
  providerFactor?: boolean;
}): "ok" | "enroll" {
  if (input.factors > 0 || input.providerFactor) return "ok";
  if (input.isAdmin || input.scope === "everyone") return "enroll";
  if (input.scope === "admins") return "ok";
  const owner = input.bindings.some((binding) => binding.role === "owner");
  return owner || input.creatingBase ? "enroll" : "ok";
}
