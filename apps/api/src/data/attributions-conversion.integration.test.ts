/**
 * The conversion to attributions (ADR 0131, migration 0150), run for real
 * on catalogs filled with generated roles: people's own and their groups',
 * on bases and tables (trashed ones too), made roles, and field and row
 * rules. The old decision is read before, the new one after, and every
 * existing table must give everyone exactly what it gave, but where the
 * review counted a case that widens. The check refuses until accepted.
 */
import {
  effectiveTableRole,
  type Binding,
  type ColumnAccess,
  type FilterGroup,
  type Given,
  type MadeRole,
  PERMISSIONS,
  type Permission,
  roleFor,
  roleGrants,
  rolePermissions,
  tableRules,
} from "@anygriddb/core";
import { migrateDb, UpgradeRefused, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { attributionsOf } from "./attributions.js";
import { catalogBefore, olderBase } from "./catalog-before.test-helpers.js";
import { insertTable } from "./schema-ops.js";

/** A small generator, the same for one seed on every run. */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  return {
    chance: (odds: number) => next() < odds,
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)] as T,
  };
}

const COLUMNS = ["title", "amount", "notes"] as const;

type Rule = {
  rows: FilterGroup | null;
  fields: Record<string, ColumnAccess> | null;
};

type World = {
  users: string[];
  bases: Array<{ id: string; tables: string[] }>;
  made: MadeRole[];
};

async function asOwner<T>(
  db: Database,
  userId: string,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`
      select set_config('anygrid.user_id', ${userId}, true),
        set_config('anygrid.source', 'test', true)
    `.execute(tx);
    return work(tx);
  });
}

/** Fills a catalog of the version before with roles, groups and rules. */
async function fill(db: Database, seed: number): Promise<World> {
  const random = generator(seed);
  const users: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    const { id } = await db
      .insertInto("users")
      .values({
        email: `p${String(index)}-${String(seed)}@example.org`,
        displayName: `Person ${String(index)}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    users.push(id);
  }
  const owner = users[0] ?? "";
  const made: MadeRole[] = [];
  for (const [name, permissions] of [
    ["Reviewer", ["rows.read", "rows.comment", "rows.lock"]],
    ["Steward", ["rows.read", "members.manage", "schema.manage"]],
    ["Clerk", ["rows.read", "rows.write", "data.export"]],
  ] as const) {
    const { id } = await asOwner(db, owner, (tx) =>
      tx
        .insertInto("madeRoles")
        .values({ name, permissions: [...permissions] })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    made.push({ id, name, permissions: [...permissions] });
  }
  const givens: Given[] = ["viewer", "commenter", "editor", "owner", ...made];
  const columnsOf = (given: Given) =>
    typeof given === "string"
      ? { role: given, madeRoleId: null }
      : { role: null, madeRoleId: given.id };

  const bases: World["bases"] = [];
  for (const name of ["North", "South"]) {
    const { id: baseId } = await olderBase(
      db,
      owner,
      `${name} ${String(seed)}`,
    );
    const tables: string[] = [];
    for (const table of ["Visits", "Notes", "Archive"]) {
      const { id } = await insertTable(db, owner, {
        baseId,
        name: table,
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "amount", label: "Amount", fieldType: "number" },
        ],
      });
      tables.push(id);
    }
    // One table of each base is in the trash.
    await asOwner(db, owner, (tx) =>
      sql`update data_tables set deleted_at = now(), deleted_by = ${owner}
          where id = ${tables[2] ?? ""}`.execute(tx),
    );
    bases.push({ id: baseId, tables });
  }

  // Groups, their members, their roles, and the copies each member had.
  const groups: string[] = [];
  for (const name of ["Clinic", "Audit"]) {
    const { id } = await asOwner(db, owner, (tx) =>
      tx
        .insertInto("groups")
        .values({ displayName: `${name} ${String(seed)}` })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    groups.push(id);
    for (const userId of users.slice(1)) {
      if (!random.chance(0.35)) continue;
      await asOwner(db, owner, (tx) =>
        tx.insertInto("groupMembers").values({ groupId: id, userId }).execute(),
      );
    }
  }
  await asOwner(db, owner, async (tx) => {
    for (const groupId of groups) {
      for (const base of bases) {
        if (!random.chance(0.5)) continue;
        const given = random.pick(givens);
        const { role, madeRoleId } = columnsOf(given);
        await sql`insert into group_roles (group_id, base_id, role, made_role_id)
                  values (${groupId}, ${base.id}, ${role}::role, ${madeRoleId})`.execute(
          tx,
        );
        await sql`insert into role_bindings (user_id, group_id, role, made_role_id, scope, scope_id)
                  select m.user_id, ${groupId}, ${role}::role, ${madeRoleId}, 'base', ${base.id}
                  from group_members m where m.group_id = ${groupId}`.execute(
          tx,
        );
      }
    }
    for (const userId of users.slice(1)) {
      for (const base of bases) {
        if (random.chance(0.7)) {
          const { role, madeRoleId } = columnsOf(random.pick(givens));
          await sql`insert into role_bindings (user_id, role, made_role_id, scope, scope_id)
                    values (${userId}, ${role}::role, ${madeRoleId}, 'base', ${base.id})`.execute(
            tx,
          );
        }
        for (const tableId of base.tables) {
          if (random.chance(0.35)) {
            const { role, madeRoleId } = columnsOf(random.pick(givens));
            await sql`insert into role_bindings (user_id, role, made_role_id, scope, scope_id)
                      values (${userId}, ${role}::role, ${madeRoleId}, 'table', ${tableId})`.execute(
              tx,
            );
          }
          if (random.chance(0.25)) {
            const filter: FilterGroup = {
              conjunction: "and",
              conditions: [
                { column: "title", op: "is", value: random.pick(["a", "b"]) },
              ],
            };
            await sql`insert into table_acls (user_id, table_id, row_filter)
                      values (${userId}, ${tableId}, ${random.chance(0.6) ? JSON.stringify(filter) : null}::jsonb)`.execute(
              tx,
            );
          }
          if (random.chance(0.2)) {
            for (const column of COLUMNS) {
              if (!random.chance(0.6)) continue;
              const access = random.pick(["hide", "read", "write"] as const);
              await sql`insert into column_acls (user_id, table_id, column_name, access)
                        values (${userId}, ${tableId}, ${column}, ${access}::column_access)`.execute(
                tx,
              );
            }
          }
        }
      }
    }
  });
  return { users, bases, made };
}

/** What a table gave, as the version before decided it. */
type Held = {
  permissions: Permission[];
  rule: Rule | null;
};

async function decidedBefore(
  db: Database,
  world: World,
): Promise<Map<string, Held>> {
  const { rows } = await sql<{
    userId: string;
    role: Given | null;
    madeId: string | null;
    scope: "base" | "table";
    scopeId: string;
  }>`select user_id as "userId", role::text as role, made_role_id as "madeId",
            scope::text as scope, scope_id as "scopeId"
     from role_bindings`.execute(db);
  const { rows: rules } = await sql<{
    userId: string;
    tableId: string;
    rowFilter: FilterGroup | null;
  }>`select user_id as "userId", table_id as "tableId", row_filter as "rowFilter"
     from table_acls`.execute(db);
  const { rows: fields } = await sql<{
    userId: string;
    tableId: string;
    column: string;
    access: ColumnAccess;
  }>`select user_id as "userId", table_id as "tableId", column_name as "column",
            access::text as access
     from column_acls`.execute(db);
  const madeOf = new Map(world.made.map((role) => [role.id, role]));
  const decided = new Map<string, Held>();
  for (const userId of world.users) {
    const bindings: Binding[] = rows
      .filter((row) => row.userId === userId)
      .flatMap((row) => {
        const role: Given | undefined =
          row.role ?? (row.madeId ? madeOf.get(row.madeId) : undefined);
        return role ? [{ role, scope: row.scope, scopeId: row.scopeId }] : [];
      });
    for (const base of world.bases) {
      for (const tableId of base.tables) {
        // A table's role replaced its base's.
        const grant =
          roleFor(bindings, "table", tableId) ??
          roleFor(bindings, "base", base.id);
        const permissions = grant ? rolePermissions(grant) : [];
        const binds = grant !== null && !roleGrants(grant, "members.manage");
        const rowRule = rules.find(
          (rule) => rule.userId === userId && rule.tableId === tableId,
        )?.rowFilter;
        const named = fields.filter(
          (rule) => rule.userId === userId && rule.tableId === tableId,
        );
        decided.set(`${userId}:${tableId}`, {
          permissions,
          rule:
            binds && (rowRule || named.length > 0)
              ? {
                  rows: rowRule ?? null,
                  fields:
                    named.length > 0
                      ? Object.fromEntries(
                          named.map((rule) => [rule.column, rule.access]),
                        )
                      : null,
                }
              : null,
        });
      }
    }
  }
  return decided;
}

/** The (person, base) pairs whose tables the review lets widen. */
async function widening(db: Database): Promise<Set<string>> {
  const { rows } = await sql<{ userId: string; baseId: string }>`
    select distinct user_id as "userId", base_id as "baseId"
    from ag_rights_review() where kind in ('manager', 'group')
  `.execute(db);
  return new Set(rows.map((row) => `${row.userId}:${row.baseId}`));
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return [...left].sort().join(",") === [...right].sort().join(",");
}

describe("the conversion to attributions", () => {
  /** The cases the generated catalogs met, over every seed. */
  const met = new Set<string>();

  it.each([7, 1_234, 98_765])(
    "keeps every existing table's access, but where it widens (seed %i)",
    async (seed) => {
      const { db, pool, close } = await catalogBefore("0150");
      try {
        const world = await fill(db, seed);
        const before = await decidedBefore(db, world);
        const widened = await widening(db);
        const { rows: kinds } = await sql<{ kind: string }>`
          select distinct kind from ag_rights_review()
        `.execute(db);
        for (const { kind } of kinds) met.add(kind);
        const { rows: counted } = await sql<{ cases: number }>`
          select count(*)::int as cases from ag_rights_review()
          where kind not in ('idle_rule')
        `.execute(db);

        // Refused, and nothing written, until the cases are accepted.
        if ((counted[0]?.cases ?? 0) > 0) {
          const refused = await migrateDb(pool).catch(
            (error: unknown) => error,
          );
          expect(refused).toBeInstanceOf(UpgradeRefused);
          expect((refused as Error).message).toContain(
            "ANYGRIDDB_ACCEPT_UPGRADE=0150",
          );
        }
        expect((await migrateDb(pool, undefined, { accept: "0150" }))[0]).toBe(
          "0150_attributions",
        );

        const after = await attributionsOf(db, world.users);
        for (const userId of world.users) {
          const bindings = after.get(userId) ?? [];
          for (const base of world.bases) {
            for (const tableId of base.tables) {
              const old = before.get(`${userId}:${tableId}`);
              const grant = effectiveTableRole(bindings, tableId, base.id);
              const now = grant ? rolePermissions(grant) : [];
              const where = `seed ${String(seed)}, person ${userId}, table ${tableId}`;
              if (widened.has(`${userId}:${base.id}`)) {
                // A manager's or a group's role stays over the table.
                expect(
                  (old?.permissions ?? []).every((permission) =>
                    now.includes(permission),
                  ),
                  where,
                ).toBe(true);
                continue;
              }
              expect(sameSet(now, old?.permissions ?? []), where).toBe(true);
              const rules = tableRules(bindings, tableId, base.id);
              if (!old?.rule) {
                expect(rules?.narrows ?? false, where).toBe(false);
                continue;
              }
              expect(rules?.rows("rows.read") ?? null, where).toEqual(
                old.rule.rows,
              );
              for (const column of COLUMNS) {
                const was = old.rule.fields
                  ? (old.rule.fields[column] ?? "hide")
                  : "write";
                expect(rules?.access(column) === "hide", where).toBe(
                  was === "hide",
                );
              }
            }
          }
        }
        // Every permission still comes from the catalogue.
        for (const bindings of after.values()) {
          for (const binding of bindings) {
            for (const permission of rolePermissions(binding.role)) {
              expect(PERMISSIONS).toContain(permission);
            }
          }
        }
      } finally {
        await close();
      }
    },
    180_000,
  );

  it("met every case the review names", () => {
    expect([...met].sort()).toEqual([
      "base_only",
      "floor",
      "group",
      "idle_rule",
      "manager",
      "ruled",
    ]);
  });

  it("refuses an upgrade from before the review that holds a table's role", async () => {
    const { db, pool, close } = await catalogBefore("0149");
    try {
      const { id: owner } = await db
        .insertInto("users")
        .values({ email: "early@example.org", displayName: "Early" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const base = await olderBase(db, owner, "Early");
      const table = await insertTable(db, owner, {
        baseId: base.id,
        name: "Visits",
        columns: [],
      });
      await asOwner(db, owner, (tx) =>
        sql`insert into role_bindings (user_id, role, scope, scope_id)
            values (${owner}, 'viewer', 'table', ${table.id})`.execute(tx),
      );
      const refused = await migrateDb(pool, undefined, {
        accept: "0150",
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(UpgradeRefused);
      expect((refused as Error).message).toContain("Upgrade to 0.11.2 first");
    } finally {
      await close();
    }
  }, 180_000);

  it("reads an operator's acceptance strictly", async () => {
    const { pool, close } = await catalogBefore("0150");
    try {
      await expect(
        migrateDb(pool, undefined, { accept: "all" }),
      ).rejects.toThrow("ANYGRIDDB_ACCEPT_UPGRADE names the migrations");
      expect((await migrateDb(pool, undefined, { accept: " 0150 " }))[0]).toBe(
        "0150_attributions",
      );
    } finally {
      await close();
    }
  }, 180_000);
});
