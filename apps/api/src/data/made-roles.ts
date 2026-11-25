/**
 * Roles an administrator makes of the permissions of a base (ADR 0128):
 * a name and the acts it gives. A binding, a group's role and an invitation
 * keep one of the four in `role` or a made role in `made_role_id`, never
 * both; every read of what one gives goes through `givenOf`.
 */
import {
  AppError,
  type Binding,
  type Given,
  type Grant,
  madePermissions,
  mayGive,
  type MadeRole,
  type Permission,
  ROLES,
  type Role,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { withAudit } from "./audit-context.js";
import { violatedUnique } from "./pg-error.js";

/** The columns of a made role a read joins as `m` beside what it reads. */
export const MADE_COLUMNS = [
  "m.id as madeId",
  "m.name as madeName",
  "m.permissions as madePermissions",
] as const;

export type GivenRow = {
  role: Role | null;
  madeId: string | null;
  madeName: string | null;
  madePermissions: string[] | null;
};

/** What a row gives: one of the four, or its made role as it stands now. */
export function givenOf(row: GivenRow): Given | null {
  if (row.role !== null) return row.role;
  if (row.madeId === null || row.madeName === null) return null;
  return {
    id: row.madeId,
    name: row.madeName,
    // The table's check keeps the list a valid one; anything else gives
    // nothing rather than a guess.
    permissions: madePermissions(row.madePermissions ?? []) ?? [],
  };
}

/** Bindings as the rules read them, from rows joined with their made role. */
export function bindingsFrom(
  rows: ReadonlyArray<GivenRow & { scope: Binding["scope"]; scopeId: string }>,
): Binding[] {
  const bindings: Binding[] = [];
  for (const row of rows) {
    const role = givenOf(row);
    if (role !== null) {
      bindings.push({ role, scope: row.scope, scopeId: row.scopeId });
    }
  }
  return bindings;
}

/** One of the four by its key, a made role by its id: what a list selects. */
export function givenKey(given: Given | null): string | null {
  if (given === null) return null;
  return typeof given === "string" ? given : given.id;
}

/** One of the four by its key, a made role by its name: what a notice says. */
export function givenName(given: Given): string {
  return typeof given === "string" ? given : given.name;
}

/** The columns that keep what is given. */
export type GivenColumns = { role: Role | null; madeRoleId: string | null };

export function givenColumns(given: Given): GivenColumns {
  return typeof given === "string"
    ? { role: given, madeRoleId: null }
    : { role: null, madeRoleId: given.id };
}

/**
 * What someone asks to give, refused when it gives more than the giver
 * holds on that base (ADR 0128).
 */
export async function givenBy(
  db: Pick<Database, "selectFrom">,
  giver: Grant,
  value: string,
): Promise<Given> {
  const given = await resolveGiven(db, value);
  assertMayTouch(giver, given);
  return given;
}

/**
 * Whoever changes or takes away someone's role must be able to give it:
 * a role beyond the giver's own is theirs only to see.
 */
export function assertMayTouch(giver: Grant, held: Given | null): void {
  if (held !== null && !mayGive(giver, held)) {
    throw new AppError("role_beyond_reach");
  }
}

/** A person's own role on a base or a table, without a group's. */
export async function ownGiven(
  db: Pick<Database, "selectFrom">,
  userId: string,
  scope: "base" | "table",
  scopeId: string,
): Promise<Given | null> {
  const row = await db
    .selectFrom("roleBindings as b")
    .leftJoin("madeRoles as m", "m.id", "b.madeRoleId")
    .select(["b.role", ...MADE_COLUMNS])
    .where("b.userId", "=", userId)
    .where("b.scope", "=", scope)
    .where("b.scopeId", "=", scopeId)
    .where("b.groupId", "is", null)
    .executeTakeFirst();
  return row ? givenOf(row) : null;
}

/** The role an invitation to a base offers, if it is one of the base's. */
export async function invitationGiven(
  db: Pick<Database, "selectFrom">,
  invitationId: string,
  baseId: string,
): Promise<Given | null> {
  const row = await db
    .selectFrom("invitations as i")
    .leftJoin("madeRoles as m", "m.id", "i.madeRoleId")
    .select(["i.role", ...MADE_COLUMNS])
    .where("i.id", "=", invitationId)
    .where("i.baseId", "=", baseId)
    .executeTakeFirst();
  return row ? givenOf(row) : null;
}

/** The role a group holds on a base, if any. */
export async function groupGiven(
  db: Pick<Database, "selectFrom">,
  groupId: string,
  baseId: string,
): Promise<Given | null> {
  const row = await db
    .selectFrom("groupRoles as r")
    .leftJoin("madeRoles as m", "m.id", "r.madeRoleId")
    .select(["r.role", ...MADE_COLUMNS])
    .where("r.groupId", "=", groupId)
    .where("r.baseId", "=", baseId)
    .executeTakeFirst();
  return row ? givenOf(row) : null;
}

/** What someone asks to give: one of the four, or a made role by its id. */
export async function resolveGiven(
  db: Pick<Database, "selectFrom">,
  value: string,
): Promise<Given> {
  if ((ROLES as readonly string[]).includes(value)) return value as Role;
  const made = await db
    .selectFrom("madeRoles")
    .select(["id", "name", "permissions"])
    .where("id", "=", value)
    .executeTakeFirst();
  if (!made) throw new AppError("unknown_role");
  return {
    id: made.id,
    name: made.name,
    permissions: madePermissions(made.permissions) ?? [],
  };
}

/** Every made role, by name: what a list of roles to give offers. */
export async function madeRoleChoices(db: Database): Promise<MadeRole[]> {
  const rows = await db
    .selectFrom("madeRoles")
    .select(["id", "name", "permissions"])
    .orderBy("name")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    permissions: madePermissions(row.permissions) ?? [],
  }));
}

export type MadeRoleListed = MadeRole & {
  /** Bindings, groups' roles and waiting invitations that hold it. */
  holders: number;
  updatedAt: Date;
};

/** Every made role, by name, with how many hold it. */
export async function listMadeRoles(db: Database): Promise<MadeRoleListed[]> {
  const rows = await db
    .selectFrom("madeRoles as m")
    .select((eb) => [
      "m.id",
      "m.name",
      "m.permissions",
      "m.updatedAt",
      eb
        .selectFrom("roleBindings as b")
        .select(eb.fn.countAll<string>().as("n"))
        .whereRef("b.madeRoleId", "=", "m.id")
        .as("bindings"),
      eb
        .selectFrom("groupRoles as g")
        .select(eb.fn.countAll<string>().as("n"))
        .whereRef("g.madeRoleId", "=", "m.id")
        .as("groups"),
      eb
        .selectFrom("invitations as i")
        .select(eb.fn.countAll<string>().as("n"))
        .whereRef("i.madeRoleId", "=", "m.id")
        .where("i.acceptedAt", "is", null)
        .where("i.expiresAt", ">", new Date())
        .as("waiting"),
    ])
    .orderBy("m.name")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    permissions: madePermissions(row.permissions) ?? [],
    updatedAt: row.updatedAt,
    holders:
      Number(row.bindings ?? 0) +
      Number(row.groups ?? 0) +
      Number(row.waiting ?? 0),
  }));
}

function checked(permissions: readonly Permission[]): Permission[] {
  const kept = madePermissions(permissions);
  if (!kept) throw new AppError("invalid_permissions");
  return kept;
}

/** Two makers who chose one name at once: the second hears it is taken. */
function nameTaken(error: unknown): never {
  if (violatedUnique(error) === "made_roles_name") {
    throw new AppError("role_name_taken", { cause: error });
  }
  throw error;
}

/** Makes a role, under the administrator's name on the change trail. */
export async function createMadeRole(
  db: Database,
  actorId: string,
  input: { name: string; permissions: readonly Permission[] },
): Promise<MadeRole> {
  const permissions = checked(input.permissions);
  return withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    await assertNameFree(tx, input.name, null);
    const made = await tx
      .insertInto("madeRoles")
      .values({ name: input.name, permissions, createdBy: actorId })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow()
      .catch(nameTaken);
    return { id: made.id, name: made.name, permissions };
  });
}

/**
 * Renames a role or changes what it gives: everyone who holds it holds
 * the new set at once.
 */
export async function updateMadeRole(
  db: Database,
  actorId: string,
  input: { id: string; name: string; permissions: readonly Permission[] },
): Promise<MadeRole> {
  const permissions = checked(input.permissions);
  return withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    await assertNameFree(tx, input.name, input.id);
    const made = await tx
      .updateTable("madeRoles")
      .set({ name: input.name, permissions, updatedAt: new Date() })
      .where("id", "=", input.id)
      .returning(["id", "name"])
      .executeTakeFirst()
      .catch(nameTaken);
    if (!made) throw new AppError("unknown_role");
    return { id: made.id, name: made.name, permissions };
  });
}

/**
 * Deletes a role nobody holds and no invitation waits with. Invitations
 * taken or expired that named it go with it.
 */
export async function deleteMadeRole(
  db: Database,
  actorId: string,
  id: string,
): Promise<void> {
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    const role = await tx
      .selectFrom("madeRoles")
      .select("id")
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!role) throw new AppError("unknown_role");
    const [bound, grouped, waiting] = await Promise.all([
      tx
        .selectFrom("roleBindings")
        .select("id")
        .where("madeRoleId", "=", id)
        .limit(1)
        .executeTakeFirst(),
      tx
        .selectFrom("groupRoles")
        .select("id")
        .where("madeRoleId", "=", id)
        .limit(1)
        .executeTakeFirst(),
      tx
        .selectFrom("invitations")
        .select("id")
        .where("madeRoleId", "=", id)
        .where("acceptedAt", "is", null)
        .where("expiresAt", ">", new Date())
        .limit(1)
        .executeTakeFirst(),
    ]);
    if (bound || grouped || waiting) throw new AppError("role_in_use");
    await tx.deleteFrom("madeRoles").where("id", "=", id).execute();
  });
}

async function assertNameFree(
  tx: Pick<Database, "selectFrom">,
  name: string,
  except: string | null,
): Promise<void> {
  // The four keep their names too, in either language a screen shows.
  if ((ROLES as readonly string[]).includes(name.toLowerCase())) {
    throw new AppError("role_name_taken");
  }
  let query = tx
    .selectFrom("madeRoles")
    .select("id")
    .where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase()));
  if (except) query = query.where("id", "<>", except);
  if (await query.executeTakeFirst()) throw new AppError("role_name_taken");
}
