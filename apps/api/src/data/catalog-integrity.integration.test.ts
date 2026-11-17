/**
 * Catalog rules that live in the database: one role on an object, an
 * address that ignores case, a file and a folder that outlive the
 * account that touched them, and the pool's own limits.
 */
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, migrateDb, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { insertBase, isUniqueViolation } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("catalog integrity", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";

  beforeAll(async () => {
    const created = await createTestDatabase("catalog");
    db = created.db;
    close = created.close;
    const person = await db
      .insertInto("users")
      .values({
        email: `owner-${suffix}@example.com`,
        displayName: "Owner",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    owner = person.id;
  });

  afterAll(async () => {
    await close?.();
  });

  it("names the application pool and ends an idle transaction", async () => {
    const found = await sql<{ app: string; idleOk: boolean }>`
      select current_setting('application_name') as app,
        current_setting('idle_in_transaction_session_timeout')::interval
          = interval '60 seconds' as idle_ok
    `.execute(db);
    expect(found.rows[0]).toEqual({ app: "anygriddb-api", idleOk: true });
  });

  it("refuses a second address that differs only by case", async () => {
    await db
      .insertInto("users")
      .values({
        email: `Ada-${suffix}@example.com`,
        displayName: "Ada",
      })
      .execute();
    await expect(
      db
        .insertInto("users")
        .values({
          email: `ada-${suffix}@example.com`,
          displayName: "Ada again",
        })
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("refuses a second role for the same person on the same object", async () => {
    const { id: baseId } = await insertBase(db, owner, { name: "Ledger" });
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`
          select set_config('anygrid.user_id', ${owner}, true),
            set_config('anygrid.source', 'web', true)
        `.execute(tx);
        await tx
          .insertInto("roleBindings")
          .values({
            userId: owner,
            role: "editor",
            scope: "base",
            scopeId: baseId,
          })
          .execute();
      }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("refuses the same role from the same group twice", async () => {
    const { id: baseId } = await insertBase(db, owner, { name: "Shared" });
    const group = await withAudit(
      db,
      { userId: owner, source: "web" },
      async (tx) =>
        tx
          .insertInto("groups")
          .values({ displayName: `Crew ${suffix}` })
          .returning("id")
          .executeTakeFirstOrThrow(),
    );
    const binding = {
      userId: owner,
      groupId: group.id,
      role: "viewer" as const,
      scope: "base" as const,
      scopeId: baseId,
    };
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx.insertInto("roleBindings").values(binding).execute(),
    );
    await expect(
      withAudit(db, { userId: owner, source: "web" }, (tx) =>
        tx.insertInto("roleBindings").values(binding).execute(),
      ),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it("keeps a file and a folder mark when the account goes", async () => {
    const guest = await db
      .insertInto("users")
      .values({
        email: `guest-${suffix}@example.com`,
        displayName: "Guest",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const { id: baseId } = await insertBase(db, owner, { name: "Files" });
    const table = await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("dataTables")
        .values({
          baseId,
          name: "Lines",
          physicalName: `t_${suffix}`,
        })
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    const key = `files/${suffix}`;
    await db
      .insertInto("attachments")
      .values({
        key,
        tableId: table.id,
        filename: "note.txt",
        mime: "text/plain",
        size: 1,
        createdBy: guest.id,
      })
      .execute();
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("tableFolders")
        .values({
          baseId,
          name: "Kept",
          deletedBy: guest.id,
        })
        .execute(),
    );

    await db.deleteFrom("users").where("id", "=", guest.id).execute();

    const file = await db
      .selectFrom("attachments")
      .select(["key", "createdBy"])
      .where("key", "=", key)
      .executeTakeFirst();
    expect(file).toEqual({ key, createdBy: null });
    const folder = await db
      .selectFrom("tableFolders")
      .select("deletedBy")
      .where("baseId", "=", baseId)
      .where("name", "=", "Kept")
      .executeTakeFirstOrThrow();
    expect(folder.deletedBy).toBeNull();
  });

  it("indexes the trails an erasure rewrites and a webhook's table", async () => {
    const found = await sql<{ name: string }>`
      select indexname as name from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'external_writes_user',
          'external_status_events_user',
          'row_signatures_user',
          'attachments_created_by',
          'webhooks_table_idx',
          'role_bindings_direct',
          'role_bindings_from_group',
          'users_email_lower',
          'users_email'
        )
    `.execute(db);
    expect(found.rows.map((row) => row.name).sort()).toEqual([
      "attachments_created_by",
      "external_status_events_user",
      "external_writes_user",
      "role_bindings_direct",
      "role_bindings_from_group",
      "row_signatures_user",
      "users_email",
      "users_email_lower",
      "webhooks_table_idx",
    ]);
  });

  it("draws a sign-up request id as a time-ordered uuid", async () => {
    const row = await db
      .insertInto("signupRequests")
      .values({
        email: `request-${suffix}@example.com`,
        displayName: "Request",
        passwordHash: "hash",
        tokenHash: `token-${suffix}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(row.id[14]).toBe("7");
  });
});

const MIGRATIONS = fileURLToPath(
  new URL("../../../../packages/db/migrations/", import.meta.url),
);

/** An empty database, migrated up to the file before `upTo`. */
async function catalogBefore(upTo: string) {
  const adminUrl = inject("adminUrl");
  const name = `catalog_upgrade_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const created = createDb(url.toString());
  const earlier = await mkdtemp(join(tmpdir(), "migrations-"));
  try {
    for (const file of await readdir(MIGRATIONS)) {
      if (file.endsWith(".sql") && file < upTo) {
        await copyFile(join(MIGRATIONS, file), join(earlier, file));
      }
    }
    await migrateDb(created.pool, earlier);
  } finally {
    await rm(earlier, { recursive: true, force: true });
  }
  return created;
}

describe("catalog integrity on a catalog that already holds a role twice", () => {
  it("keeps the highest role of each grant, and every other grant", async () => {
    const { db, pool, close } = await catalogBefore("0104");
    try {
      const people = await db
        .insertInto("users")
        .values(
          ["owner", "twice", "member"].map((name) => ({
            email: `${name}-${suffix}@example.com`,
            displayName: name,
          })),
        )
        .returning(["id", "displayName"])
        .execute();
      const id = (name: string) =>
        people.find((person) => person.displayName === name)?.id ?? "";
      const { id: baseId } = await insertBase(db, id("owner"), {
        name: "Before",
      });
      await withAudit(
        db,
        { userId: id("owner"), source: "web" },
        async (tx) => {
          const group = await tx
            .insertInto("groups")
            .values({ displayName: `Crew ${suffix}` })
            .returning("id")
            .executeTakeFirstOrThrow();
          const base = { scope: "base" as const, scopeId: baseId };
          await tx
            .insertInto("roleBindings")
            .values([
              // What two grants at once could leave behind.
              { ...base, userId: id("owner"), role: "viewer" },
              { ...base, userId: id("twice"), role: "viewer" },
              { ...base, userId: id("twice"), role: "editor" },
              { ...base, userId: id("twice"), role: "commenter" },
              {
                ...base,
                userId: id("member"),
                groupId: group.id,
                role: "editor",
              },
              {
                ...base,
                userId: id("member"),
                groupId: group.id,
                role: "editor",
              },
              // A person's own role beside the one a group gives: both stay.
              { ...base, userId: id("member"), role: "viewer" },
            ])
            .execute();
        },
      );

      const ran = await migrateDb(pool);
      expect(ran[0]).toBe("0104_catalog_integrity");
      const left = await db
        .selectFrom("roleBindings")
        .innerJoin("users", "users.id", "roleBindings.userId")
        .select(["users.displayName as name", "role", "groupId"])
        .where("scopeId", "=", baseId)
        .orderBy("users.displayName")
        .orderBy("role")
        .execute();
      expect(
        left.map((row) => [row.name, row.role, row.groupId !== null]),
      ).toEqual([
        ["member", "editor", true],
        ["member", "viewer", false],
        ["owner", "owner", false],
        ["twice", "editor", false],
      ]);
      // And from now on, the database refuses what was cleaned up.
      await expect(
        withAudit(db, { userId: id("owner"), source: "web" }, (tx) =>
          tx
            .insertInto("roleBindings")
            .values({
              userId: id("twice"),
              role: "viewer",
              scope: "base",
              scopeId: baseId,
            })
            .execute(),
        ),
      ).rejects.toSatisfy(isUniqueViolation);
    } finally {
      await close();
    }
  });
});

describe("a catalog that holds a source of a store no longer read", () => {
  async function withSources(
    engines: readonly string[],
  ): Promise<Awaited<ReturnType<typeof catalogBefore>> & { owner: string }> {
    const created = await catalogBefore("0116");
    const person = await created.db
      .insertInto("users")
      .values({
        email: `stores-${randomBytes(4).toString("hex")}@example.com`,
        displayName: "Owner",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await withAudit(
      created.db,
      { userId: person.id, source: "web" },
      async (tx) => {
        for (const engine of engines) {
          await sql`
            insert into sources
              (name, engine, host, port, database, username,
               password_ciphertext, password_nonce)
            values
              (${`Source ${engine}`}, ${engine}::source_engine,
               'db.example.org', 5432, 'shop', 'reader', '\\x00', '\\x00')
          `.execute(tx);
        }
      },
    );
    return { ...created, owner: person.id };
  }

  it("refuses to migrate, says why, and changes nothing", async () => {
    const { db, pool, close } = await withSources(["postgres", "redis"]);
    try {
      let refused: unknown;
      try {
        await migrateDb(pool);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(Error);
      expect(String((refused as Error).cause)).toContain(
        "no longer reads Redis, Cassandra, or Neo4j",
      );
      const kept = await sql<{ engine: string }>`
        select engine::text as engine from sources order by engine::text
      `.execute(db);
      expect(kept.rows.map((row) => row.engine)).toEqual(["postgres", "redis"]);
      const applied = await sql<{ name: string }>`
        select name from schema_migrations where name like '0116%'
      `.execute(db);
      expect(applied.rows).toEqual([]);
    } finally {
      await close();
    }
  });

  it("keeps the sources it still reads, and takes no such store again", async () => {
    const { db, pool, close, owner } = await withSources([
      "postgres",
      "mongodb",
      "sqlite",
    ]);
    try {
      const ran = await migrateDb(pool);
      expect(ran[0]).toBe("0116_fewer_copy_stores");
      const kept = await sql<{ engine: string }>`
        select engine::text as engine from sources order by engine::text
      `.execute(db);
      expect(kept.rows.map((row) => row.engine)).toEqual([
        "mongodb",
        "postgres",
        "sqlite",
      ]);
      await expect(
        sql`select 'redis'::source_engine`.execute(db),
      ).rejects.toThrow(/invalid input value for enum source_engine/);
      // A change of a source is still on the trail: the trigger that
      // names the column came back.
      await withAudit(db, { userId: owner, source: "web" }, (tx) =>
        sql`
          update sources set host = 'other.example.org'
          where engine = 'mongodb'
        `.execute(tx),
      );
      const trail = await sql<{ count: string }>`
        select count(*)::text as count from audit_events
        where catalog_table = 'sources'
          and new_value ->> 'host' = 'other.example.org'
      `.execute(db);
      expect(trail.rows[0]?.count).toBe("1");
    } finally {
      await close();
    }
  });
});
