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

/**
 * A role an administrator made of permissions (ADR 0128), given on a base
 * or a table as one of the four is.
 */
export type MadeRole = {
  id: string;
  name: string;
  permissions: readonly Permission[];
};

/** What one binding gives: one of the four, or a made role. */
export type Given = Role | MadeRole;

/**
 * What applies on one base or one table when a made role is among it:
 * the highest of the four that applies there too, if any, the made roles,
 * and what they give together.
 */
export type Held = {
  role: Role | null;
  made: ReadonlyArray<{ id: string; name: string }>;
  permissions: readonly Permission[];
};

/**
 * What applies on one base or one table: one of the four alone, as
 * before made roles, or the roles together.
 */
export type Grant = Role | Held;

/**
 * What applies, as one word an API answers with: one of the four by its
 * key, or the made roles by their names (after the four's key), joined.
 */
export function grantName(grant: Grant | null): string | null {
  if (grant === null) return null;
  if (typeof grant === "string") return grant;
  return [
    ...(grant.role ? [grant.role] : []),
    ...grant.made.map((made) => made.name),
  ].join(" + ");
}

/** The permissions a role, a made role or roles held together give. */
export function rolePermissions(role: Role | MadeRole | Held): Permission[] {
  return PERMISSIONS.filter((permission) => roleGrants(role, permission));
}

/** The one decision: whether what applies, if anything, gives this permission. */
export function roleGrants(
  role: Role | MadeRole | Held | null | undefined,
  permission: Permission,
): boolean {
  if (role == null) return false;
  if (typeof role === "string") return PACKS[role].has(permission);
  return role.permissions.includes(permission);
}

/**
 * Whoever holds `giver` may give `given`: one of the four up to their own
 * reach, the owner's only by an owner, and a made role only when they hold
 * every permission it gives. Nobody gives more than they hold.
 */
export function mayGive(giver: Grant | MadeRole | null, given: Given): boolean {
  if (giver === "owner") return true;
  if (!roleGrants(giver, "members.manage")) return false;
  if (given === "owner") return false;
  return rolePermissions(given).every((permission) =>
    roleGrants(giver, permission),
  );
}

/**
 * What a read-only token leaves of a role: what a viewer may, and no more
 * than the role gave (ADR 0128).
 */
export function readOnlyGiven(given: Given): Given {
  if (typeof given === "string") return "viewer";
  return {
    ...given,
    permissions: given.permissions.filter((permission) =>
      PACKS.viewer.has(permission),
    ),
  };
}

/** Whether a made role's permissions are a set it can be: read first. */
export function madePermissions(
  permissions: readonly string[],
): Permission[] | null {
  const wanted = new Set(permissions);
  if (!wanted.has("rows.read")) return null;
  if ([...wanted].some((permission) => !isPermission(permission))) {
    return null;
  }
  return PERMISSIONS.filter((permission) => wanted.has(permission));
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Roles of Administration an administrator gives beside administration,
 * support and the auditor (ROADMAP #34, ADR 0126): each opens one part of
 * Administration, and nothing outside it.
 */
export const INSTANCE_ROLES = ["account_manager", "source_manager"] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

export type Binding = {
  role: Given;
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

/**
 * What applies on this exact scope, if anything: the highest of the four
 * bound there, as always; with a made role among them, every role bound
 * there together, each giving what it gives (an owner holds it all).
 */
export function roleFor(
  bindings: readonly Binding[],
  scope: Scope,
  scopeId: string,
): Grant | null {
  let best: Role | null = null;
  const made = new Map<string, MadeRole>();
  for (const binding of bindings) {
    if (binding.scope !== scope || binding.scopeId !== scopeId) {
      continue;
    }
    if (typeof binding.role !== "string") {
      made.set(binding.role.id, binding.role);
    } else if (!best || ROLE_RANK[binding.role] > ROLE_RANK[best]) {
      best = binding.role;
    }
  }
  if (made.size === 0 || best === "owner") return best;
  const roles = [...made.values()];
  return {
    role: best,
    made: roles.map(({ id, name }) => ({ id, name })),
    permissions: PERMISSIONS.filter(
      (permission) =>
        (best !== null && PACKS[best].has(permission)) ||
        roles.some((role) => role.permissions.includes(permission)),
    ),
  };
}

/**
 * Role on a table: a binding on the table itself overrides, otherwise the
 * role on its base applies. A table override may grant less than the base.
 */
export function effectiveTableRole(
  bindings: readonly Binding[],
  tableId: string,
  baseId: string | undefined,
): Grant | null {
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
 * then, as the instance chooses, owners (and whoever a made role lets
 * give access or run a base) and anyone creating a base (the default),
 * every account, or nobody else. Anyone else the identity provider
 * vouches for (`providerFactor`) counts as enrolled.
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
  // An owner, or whoever a made role lets give access or run the base.
  const owner = input.bindings.some(
    (binding) =>
      roleGrants(binding.role, "members.manage") ||
      roleGrants(binding.role, "base.manage"),
  );
  return owner || input.creatingBase ? "enroll" : "ok";
}
