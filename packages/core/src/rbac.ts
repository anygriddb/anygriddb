import type { ColumnAccess } from "./acl";
import type { FilterGroup } from "./filter";

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
  /**
   * Take the steps a circuit gives owners: lock, sign and unlock on the
   * compliance circuit (ADR 0124).
   */
  "rows.lock",
  /**
   * Take a step of a table's circuit at all: a step then names who takes
   * it, one of the four or a made role (ADR 0130). So "may validate" is
   * given without writing rows or locking them.
   */
  "rows.transition",
  /**
   * Rows taken out of the base: files of rows, calendar feeds, a base's
   * snapshot and copies, links that show rows, webhooks, and automations
   * that send values elsewhere.
   */
  "data.export",
  /**
   * A token's way in: the REST API, MCP, and the applications given
   * access. A token reaches nothing on a base or a table whose role does
   * not give it.
   */
  "api.access",
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

/**
 * The shipped roles: the four of a rank, then three that are not on it
 * (ADR 0131): a reader takes nothing out of the base, a contributor edits
 * without exporting or publishing, a validator takes a circuit's steps.
 */
export const ROLES = [
  "owner",
  "editor",
  "commenter",
  "viewer",
  "contributor",
  "validator",
  "reader",
] as const;
export type Role = (typeof ROLES)[number];

const VIEWER: readonly Permission[] = [
  "rows.read",
  "data.export",
  "api.access",
];
const COMMENTER: readonly Permission[] = [...VIEWER, "rows.comment"];
const EDITOR: readonly Permission[] = [
  ...COMMENTER,
  "rows.write",
  "rows.transition",
  "rows.delete",
  "data.import",
  "publish",
  "views.manage",
];

/**
 * The shipped roles as packs of permissions. The four of a rank give
 * exactly what their rank gave before permissions were named
 * (`rbac.test.ts` holds them to it); the owner holds every permission.
 */
const PACKS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  commenter: new Set(COMMENTER),
  editor: new Set(EDITOR),
  owner: new Set(PERMISSIONS),
  reader: new Set(["rows.read", "rows.comment"]),
  contributor: new Set([
    "rows.read",
    "rows.comment",
    "rows.write",
    "rows.delete",
    "rows.transition",
    "data.import",
  ]),
  validator: new Set(["rows.read", "rows.comment", "rows.transition"]),
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
 * What applies on one base or one table when several roles do: the
 * highest of the four of a rank, if any, the other shipped roles it does
 * not cover, the made roles, and what they give together.
 */
export type Held = {
  role: Role | null;
  shipped: readonly Role[];
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
    ...grant.shipped,
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

/** Whether what applies, if anything, gives every permission asked. */
export function roleGrantsAll(
  role: Role | MadeRole | Held | null | undefined,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => roleGrants(role, permission));
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
 * Whether a role acts through a token: when it gives a token's way in
 * (`api.access`), as each of the four of a rank does. One that does not
 * gives a token nothing, and takes nothing away from what another role
 * gives (ADR 0131).
 */
export function tokenGiven(given: Given): boolean {
  return roleGrants(given, "api.access");
}

/** A public link: a form takes answers in; a view's or a base's shows rows. */
export type LinkKind = "form" | "view" | "base";

/**
 * What a public link asks of its creator's role on its table or its base,
 * when it is made and each time it is opened: a link that shows rows to
 * whoever holds it is an export.
 */
export const LINK_PERMISSIONS: Record<LinkKind, readonly Permission[]> = {
  form: ["publish"],
  view: ["publish", "data.export"],
  base: ["base.manage", "publish", "data.export"],
};

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

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Roles of Administration an administrator gives beside administration,
 * support and the auditor (ROADMAP #34, ADR 0126): each opens one part of
 * Administration, and nothing outside it.
 */
export const INSTANCE_ROLES = ["account_manager", "source_manager"] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

/**
 * What a part of Administration lets someone do, one act each. Every
 * procedure of Administration names what it asks, and whoever calls it
 * holds it through what they are: an administrator, support, an auditor,
 * an account manager, a source manager.
 */
export const INSTANCE_PERMISSIONS = [
  /**
   * The helpdesk: find an account, open it and its sessions, end them,
   * unlock it, send a reset link, clear its second factors, unlink its
   * single sign-on, revoke its API tokens. On an account that holds a
   * role of Administration only for an administrator (`helpdeskReach`).
   */
  "accounts.help",
  /** Add a person, change their name and address, disable or enable them. */
  "accounts.manage",
  /**
   * What reaches a whole account: a file of people, handing over what a
   * person owns, taking their data out, erasing them, acting as them.
   */
  "accounts.control",
  /** End every session but one's own, of the accounts in reach. */
  "sessions.end",
  /** The groups and who is in them. */
  "groups.manage",
  /** The roles an administrator makes of a base's permissions. */
  "roles.manage",
  /** Roles of Administration, and a role on any base, given or taken. */
  "access.grant",
  /**
   * Who reaches what without a session: tokens, webhooks, automations,
   * links and feeds; a person's effective rights, now or at a date.
   */
  "access.oversee",
  /** The list of bases, their invitations, a base opened or put away. */
  "bases.oversee",
  /** A new base, an imported workbook or snapshot, a base brought in. */
  "bases.create",
  /** The client databases, what they expose, and into which bases. */
  "sources.manage",
  /** Every table a client's database holds, exposed or not. */
  "sources.browse",
  /** The instance's settings, sign-in, provisioning and integrations. */
  "settings.manage",
  /** Health, logs, alerts, jobs, deliveries, releases, notices. */
  "instance.operate",
  /** The change trail and the sign-in trail. */
  "trails.read",
  /** The trails and the access report taken out as files. */
  "trails.export",
] as const;
export type InstancePermission = (typeof INSTANCE_PERMISSIONS)[number];

/** Who calls Administration, each by what they are. */
export const INSTANCE_CALLERS = [
  "administrator",
  "support",
  "auditor",
  ...INSTANCE_ROLES,
] as const;
export type InstanceCaller = (typeof INSTANCE_CALLERS)[number];

/**
 * What each caller of Administration holds. An auditor also reads every
 * page of Administration, by what a procedure is (a query), apart from
 * what reaches out to a client's database (`sources.browse`).
 */
const INSTANCE_PACKS: Record<
  InstanceCaller,
  ReadonlySet<InstancePermission>
> = {
  administrator: new Set(INSTANCE_PERMISSIONS),
  support: new Set(["accounts.help", "sessions.end", "trails.read"]),
  auditor: new Set(["trails.read", "trails.export"]),
  account_manager: new Set([
    "accounts.help",
    "accounts.manage",
    "groups.manage",
  ]),
  source_manager: new Set(["sources.manage", "sources.browse"]),
};

/** What an account is in Administration, from what it holds. */
export function instanceCallers(account: {
  isAdmin: boolean;
  isSupport: boolean;
  isAuditor: boolean;
  instanceRoles: readonly InstanceRole[];
}): InstanceCaller[] {
  return [
    ...(account.isAdmin ? (["administrator"] as const) : []),
    ...(account.isSupport ? (["support"] as const) : []),
    ...(account.isAuditor ? (["auditor"] as const) : []),
    ...account.instanceRoles,
  ];
}

/** Whether one of these callers holds the permission. */
export function callersHold(
  callers: readonly InstanceCaller[],
  permission: InstancePermission,
): boolean {
  return callers.some((caller) => INSTANCE_PACKS[caller].has(permission));
}

/** The permissions these callers hold together. */
export function callersPermissions(
  callers: readonly InstanceCaller[],
): InstancePermission[] {
  return INSTANCE_PERMISSIONS.filter((permission) =>
    callersHold(callers, permission),
  );
}

export function isInstancePermission(
  value: string,
): value is InstancePermission {
  return (INSTANCE_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * One attribution (ADR 0131): a role on a base or a table, given to the
 * person or to one of their groups. On a table it may narrow what it
 * gives: to some rows (`rows`), and field by field (`fields`, a field not
 * named being hidden). A rule narrows only the attribution it comes with.
 */
export type Binding = {
  role: Given;
  scope: Scope;
  scopeId: string;
  rows?: FilterGroup | null;
  fields?: Readonly<Record<string, ColumnAccess>> | null;
  /**
   * What a delegated access acting through it was entrusted (ADR 0131,
   * §5): the role gives no more than these. Absent, all the role gives.
   */
  entrusted?: readonly Permission[] | null;
};

/** Whether an attribution gives a permission, within what was entrusted. */
function bindingGrants(
  binding: Pick<Binding, "role" | "entrusted">,
  permission: Permission,
): boolean {
  return (
    roleGrants(binding.role, permission) &&
    (binding.entrusted == null || binding.entrusted.includes(permission))
  );
}

/** The four of a rank, by it; the other shipped roles are on no rank. */
const ROLE_RANK: Partial<Record<Role, number>> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};

/** A role's place on the rank of the four; 0 for a role on none. */
export function roleRank(role: Role): number {
  return ROLE_RANK[role] ?? 0;
}

/** Whether one shipped role gives all another gives. */
function covers(wide: Role, narrow: Role): boolean {
  return [...PACKS[narrow]].every((permission) => PACKS[wide].has(permission));
}

/** What several roles held together are made of, before one word for them. */
type Parts = {
  shipped: Set<Role>;
  made: Map<string, { id: string; name: string }>;
  permissions: Set<Permission>;
};

function emptyParts(): Parts {
  return { shipped: new Set(), made: new Map(), permissions: new Set() };
}

function addGiven(
  parts: Parts,
  given: Given,
  entrusted?: readonly Permission[] | null,
): void {
  const kept = (permission: Permission) =>
    entrusted == null || entrusted.includes(permission);
  const permissions =
    typeof given === "string" ? [...PACKS[given]] : given.permissions;
  if (typeof given === "string") parts.shipped.add(given);
  else parts.made.set(given.id, { id: given.id, name: given.name });
  for (const permission of permissions) {
    if (kept(permission)) parts.permissions.add(permission);
  }
}

/** Whether what is held is exactly what one shipped role gives. */
function holdsExactly(parts: Parts, role: Role): boolean {
  return (
    parts.permissions.size === PACKS[role].size &&
    [...PACKS[role]].every((permission) => parts.permissions.has(permission))
  );
}

function addGrant(parts: Parts, grant: Grant): void {
  if (typeof grant === "string") {
    addGiven(parts, grant);
    return;
  }
  if (grant.role) parts.shipped.add(grant.role);
  for (const role of grant.shipped) parts.shipped.add(role);
  for (const item of grant.made) parts.made.set(item.id, item);
  for (const permission of grant.permissions) parts.permissions.add(permission);
}

/**
 * One word for what roles held together give: a single shipped role when
 * the others add nothing to it (the highest of the four of a rank, or one
 * that covers all held), the owner's whole, or what they give together.
 */
function composed(parts: Parts): Grant | null {
  const shipped = [...parts.shipped];
  if (shipped.length === 0 && parts.made.size === 0) return null;
  let best: Role | null = null;
  for (const role of shipped) {
    const rank = ROLE_RANK[role];
    if (
      rank !== undefined &&
      (best === null || rank > (ROLE_RANK[best] ?? 0))
    ) {
      best = role;
    }
  }
  if (best === "owner" && holdsExactly(parts, "owner")) return "owner";
  // Shipped roles beyond the highest of the four, the narrower ones left
  // out where another held covers them.
  const others = shipped.filter(
    (role) =>
      ROLE_RANK[role] === undefined &&
      !(best !== null && covers(best, role)) &&
      !shipped.some(
        (other) =>
          other !== role &&
          ROLE_RANK[other] === undefined &&
          covers(other, role) &&
          !covers(role, other),
      ),
  );
  // One word only where it says exactly what is held: what a delegated
  // access was entrusted may leave less than the role gives.
  if (parts.made.size === 0) {
    if (others.length === 0 && best !== null && holdsExactly(parts, best)) {
      return best;
    }
    const only = others[0];
    if (
      best === null &&
      others.length === 1 &&
      only !== undefined &&
      holdsExactly(parts, only)
    ) {
      return only;
    }
  }
  return {
    role: best,
    shipped: others,
    made: [...parts.made.values()],
    permissions: PERMISSIONS.filter((permission) =>
      parts.permissions.has(permission),
    ),
  };
}

/**
 * What applies on this exact scope, if anything: what every role bound
 * there gives together, named by the highest of the four alone when the
 * others add nothing (an owner holds it all).
 */
export function roleFor(
  bindings: readonly Binding[],
  scope: Scope,
  scopeId: string,
): Grant | null {
  const parts = emptyParts();
  for (const binding of bindings) {
    if (binding.scope !== scope || binding.scopeId !== scopeId) continue;
    addGiven(parts, binding.role, binding.entrusted);
  }
  return composed(parts);
}

/** What two grants give together: each permission either gives. */
function unionOf(first: Grant | null, second: Grant | null): Grant | null {
  if (first === null) return second;
  if (second === null) return first;
  const parts = emptyParts();
  addGrant(parts, first);
  addGrant(parts, second);
  return composed(parts);
}

/**
 * What applies on a table: what its base gives and what the table itself
 * gives, together (ADR 0131). A role given on a table only adds.
 */
export function effectiveTableRole(
  bindings: readonly Binding[],
  tableId: string,
  baseId: string | undefined,
): Grant | null {
  return unionOf(
    roleFor(bindings, "table", tableId),
    baseId ? roleFor(bindings, "base", baseId) : null,
  );
}

/** A filter no row passes: an attribution that gives nothing here. */
const NO_ROW: FilterGroup = { conjunction: "or", conditions: [] };

const ACCESS_RANK: Record<ColumnAccess, number> = {
  hide: 0,
  read: 1,
  write: 2,
};

/** Whether an attribution's rules hold: who manages the table is never narrowed. */
function narrowing(binding: Binding): boolean {
  return (
    (binding.rows != null || binding.fields != null) &&
    !bindingGrants(binding, "members.manage")
  );
}

/** The rows an attribution reaches: every row when no rule holds. */
function rowsThrough(binding: Binding): FilterGroup | null {
  return narrowing(binding) ? (binding.rows ?? null) : null;
}

/** A field's access through one attribution, never above its role. */
function fieldThrough(binding: Binding, column: string): ColumnAccess {
  if (!bindingGrants(binding, "rows.read")) return "hide";
  const fields = narrowing(binding) ? binding.fields : null;
  const said = fields ? (fields[column] ?? "hide") : "write";
  if (said === "write" && !bindingGrants(binding, "rows.write")) {
    return "read";
  }
  return said;
}

/**
 * The rules that narrow someone's access to one table, or undefined when
 * no attribution that reaches it carries one. The rows reached for an act
 * are those of every attribution that gives it, by OR (one without a
 * filter: every row); a field takes the widest access any of them gives.
 */
export type TableRules = {
  rows: (act: Permission) => FilterGroup | undefined;
  access: (column: string) => ColumnAccess;
  /**
   * Whether the rules keep anything of the table from its reader: some
   * rows, or a field no attribution that reads rows shows whole.
   */
  narrows: boolean;
  /** What they keep: rows (some are not read), fields (by a rule). */
  narrowed: { rows: boolean; fields: boolean };
};

export function tableRules(
  bindings: readonly Binding[],
  tableId: string,
  baseId: string | undefined,
): TableRules | undefined {
  const reach = bindings.filter(
    (binding) =>
      (binding.scope === "table" && binding.scopeId === tableId) ||
      (binding.scope === "base" &&
        baseId !== undefined &&
        binding.scopeId === baseId),
  );
  if (!reach.some(narrowing)) return undefined;
  const rows = (act: Permission): FilterGroup | undefined => {
    const givers = reach.filter((binding) => bindingGrants(binding, act));
    if (givers.some((binding) => !rowsThrough(binding))) return undefined;
    const filters = givers.flatMap((binding) => {
      const through = rowsThrough(binding);
      return through ? [through] : [];
    });
    if (filters.length === 0) return NO_ROW;
    if (filters.length === 1) return filters[0];
    return { conjunction: "or", conditions: filters };
  };
  const narrowed = {
    rows: rows("rows.read") !== undefined,
    fields: !reach.some(
      (binding) =>
        !(narrowing(binding) && binding.fields) &&
        bindingGrants(binding, "rows.read"),
    ),
  };
  return {
    rows,
    narrows: narrowed.rows || narrowed.fields,
    narrowed,
    access: (column) => {
      let best: ColumnAccess = "hide";
      for (const binding of reach) {
        const access = fieldThrough(binding, column);
        if (ACCESS_RANK[access] > ACCESS_RANK[best]) best = access;
      }
      return best;
    },
  };
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
      bindingGrants(binding, "members.manage") ||
      bindingGrants(binding, "base.manage"),
  );
  return owner || input.creatingBase ? "enroll" : "ok";
}
