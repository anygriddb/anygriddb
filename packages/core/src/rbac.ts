export type Scope = "base" | "table" | "row" | "column";

/**
 * What a role on a base or a table lets someone do, one act each
 * (ADR 0127). Every check of a base or a table names the act it guards,
 * on the server and on the screens, and asks `roleGrants`.
 */
export const PERMISSIONS = [
  /** Rows, their history and comments, views of one's own. */
  "rows.read",
  "rows.comment",
  /** Add and change rows, submit a draft, press a button. */
  "rows.write",
  /** Move rows to the trash. */
  "rows.delete",
  /** Lock, sign and unlock rows. */
  "rows.lock",
  /** Files of rows, calendar feeds, a base's snapshot. */
  "data.export",
  /** Files into a table, a workbook into a base. */
  "data.import",
  /** Public links to a view, a form or a base. */
  "publish",
  /** Views everyone with a role sees, and their order. */
  "views.manage",
  "dashboards.manage",
  /** Tables, folders, fields, status circuits, locked views. */
  "schema.manage",
  "automations.manage",
  "webhooks.manage",
  /** Roles, invitations, and the field and row rules of each member. */
  "members.manage",
  /** The base itself: its name, the trash, copies and restore points. */
  "base.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["owner", "editor", "commenter", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const VIEWER: readonly Permission[] = ["rows.read", "data.export"];
const COMMENTER: readonly Permission[] = [...VIEWER, "rows.comment"];
const EDITOR: readonly Permission[] = [
  ...COMMENTER,
  "rows.write",
  "rows.delete",
  "data.import",
  "publish",
  "views.manage",
];

/**
 * The four roles as packs of permissions. Each gives exactly what its
 * rank gave before permissions were named (`rbac.test.ts` holds them to
 * it); the owner holds every permission.
 */
const PACKS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  commenter: new Set(COMMENTER),
  editor: new Set(EDITOR),
  owner: new Set(PERMISSIONS),
};

/** The permissions a role gives, in the catalogue's order. */
export function rolePermissions(role: Role): Permission[] {
  return PERMISSIONS.filter((permission) => PACKS[role].has(permission));
}

/** The one decision: whether a role, if any, gives this permission. */
export function roleGrants(
  role: Role | null | undefined,
  permission: Permission,
): boolean {
  return role != null && PACKS[role].has(permission);
}

/**
 * Roles of Administration an administrator gives beside administration,
 * support and the auditor (ROADMAP #34, ADR 0126): each opens one part of
 * Administration, and nothing outside it.
 */
export const INSTANCE_ROLES = ["account_manager", "source_manager"] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

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

export function roleRank(role: Role): number {
  return ROLE_RANK[role];
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
 * Whether the bindings give `permission`. For a table, pass its `baseId`
 * so the base role applies when the table has no override.
 */
export function can(
  bindings: readonly Binding[],
  permission: Permission,
  scope: Scope,
  scopeId: string,
  baseId?: string,
): boolean {
  const role =
    scope === "table"
      ? effectiveTableRole(bindings, scopeId, baseId)
      : roleFor(bindings, scope, scopeId);
  return roleGrants(role, permission);
}

/**
 * Who must confirm a second factor before working (ADR 0043):
 * administrators always, with one of their own whatever a provider says;
 * then, as the instance chooses, owners and anyone creating a base (the
 * default), every account, or nobody else. Anyone else the identity
 * provider vouches for (`providerFactor`) counts as enrolled.
 */
export function enrollmentGate(input: {
  bindings: readonly Binding[];
  factors: number;
  creatingBase?: boolean;
  isAdmin: boolean;
  scope: "admins" | "owners" | "everyone";
  providerFactor?: boolean;
}): "ok" | "enroll" {
  if (input.factors > 0) return "ok";
  if (input.isAdmin) return "enroll";
  if (input.providerFactor) return "ok";
  if (input.scope === "everyone") return "enroll";
  if (input.scope === "admins") return "ok";
  const owner = input.bindings.some((binding) => binding.role === "owner");
  return owner || input.creatingBase ? "enroll" : "ok";
}
