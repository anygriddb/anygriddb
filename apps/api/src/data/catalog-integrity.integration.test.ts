/**
 * Catalog rules that live in the database: one role on an object, an
 * address that ignores case, a file and a folder that outlive the
 * account that touched them, and the pool's own limits.
 */
import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  migrateDb,
  migrationNames,
  UpgradeRefused,
  type Database,
} from "@anygriddb/db";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { loadEngine } from "./engine.js";
import {
  deleteRows,
  insertRows,
  restoreRows,
  updateRows,
  type WriteContext,
} from "./rows.js";
import { insertBase, insertTable, isUniqueViolation } from "./schema-ops.js";

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

/** A database that holds nothing, not even the record of a migration. */
async function emptyDatabase() {
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
  return createDb(url.toString());
}

/** A folder of the migrations before `upTo`: what an earlier version ships. */
async function migrationsBefore(upTo: string): Promise<string> {
  const earlier = await mkdtemp(join(tmpdir(), "migrations-"));
  for (const file of await readdir(MIGRATIONS)) {
    if (file.endsWith(".sql") && file < upTo) {
      await copyFile(join(MIGRATIONS, file), join(earlier, file));
    }
  }
  return earlier;
}

/** A folder of migrations written for one test. */
async function migrationsOf(files: Record<string, string>): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "migrations-"));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(folder, name), text);
  }
  return folder;
}

/** An empty database, migrated up to the file before `upTo`. */
async function catalogBefore(upTo: string) {
  const created = await emptyDatabase();
  const earlier = await migrationsBefore(upTo);
  try {
    await migrateDb(created.pool, earlier);
  } finally {
    await rm(earlier, { recursive: true, force: true });
  }
  return created;
}

const STRUCTURE = "0130_structure_through_the_owner.sql";

/**
 * The owner's functions the application now makes its tables with, which an
 * older catalog lacks: lent while a test fills that catalog as the
 * application does, and taken back before the upgrade makes them.
 */
async function lendStructure(pool: pg.Pool): Promise<void> {
  const text = await readFile(join(MIGRATIONS, STRUCTURE), "utf8");
  for (const statement of text.split("--> statement-breakpoint")) {
    await pool.query(statement);
  }
}

async function takeBackStructure(pool: pg.Pool): Promise<void> {
  const text = await readFile(join(MIGRATIONS, STRUCTURE), "utf8");
  const names = [...text.matchAll(/^CREATE FUNCTION (\w+)\(/gm)].map(
    (match) => match[1],
  );
  const { rows } = await pool.query<{ signature: string }>(
    `select p.oid::regprocedure::text as signature from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`,
    [names],
  );
  for (const { signature } of rows) {
    await pool.query(`drop function ${signature}`);
  }
}

/** The migrations the database says it ran, in order. */
async function appliedTo(db: Database): Promise<string[]> {
  const applied = await sql<{ name: string }>`
    select name from schema_migrations order by name
  `.execute(db);
  return applied.rows.map((row) => row.name);
}

/**
 * Each released version, with the first migration it did not have: an
 * instance of that version is upgraded from the catalog before it. A
 * release adds its line, with the next free number.
 */
const RELEASED = [
  ["0.1.0", "0115"],
  ["0.2.0", "0118"],
  ["0.3.0", "0119"],
  ["0.3.1", "0120"],
  ["0.3.2", "0120"],
  ["0.3.3", "0121"],
  ["0.3.4", "0121"],
  ["0.3.5", "0121"],
  ["0.3.6", "0121"],
  ["0.4.0", "0122"],
  ["0.4.1", "0122"],
  ["0.4.2", "0123"],
  ["0.5.0", "0127"],
  ["0.6.0", "0128"],
  ["0.6.1", "0129"],
  ["0.7.0", "0133"],
  ["0.7.1", "0134"],
  ["0.7.2", "0135"],
  ["0.7.3", "0135"],
  ["0.7.4", "0135"],
  ["0.7.5", "0135"],
  ["0.8.0", "0137"],
  ["0.9.0", "0138"],
  ["0.9.1", "0139"],
  ["0.9.2", "0140"],
  ["0.9.3", "0140"],
  ["0.10.0", "0143"],
  ["0.10.1", "0145"],
  ["0.10.2", "0146"],
  ["0.11.0", "0148"],
  ["0.11.1", "0149"],
] as const;

// An instance is upgraded from any release, not only from the last: the
// migrations since it run on its catalog, and every check is asked of it
// (ADR 0106) and refuses nothing it has no reason to.
describe("an upgrade from each released version", () => {
  it.each(RELEASED)(
    "runs the migrations since %s on the catalog it left",
    async (_version, next) => {
      const { db, pool, close } = await catalogBefore(next);
      try {
        const known = await migrationNames();
        const pending = known.filter((name) => name >= next);
        expect(await appliedTo(db)).toEqual(
          known.filter((name) => name < next),
        );
        expect(await migrateDb(pool)).toEqual(pending);
        expect(await appliedTo(db)).toEqual(known);
      } finally {
        await close();
      }
    },
  );
});

// A file imported by an earlier version could leave a table, and the one
// sequence that places every table's new rows, at numbers nothing can
// follow. The upgrade brings them back, and leaves anything else alone.
describe("an upgrade of an instance whose row numbers ran out", () => {
  const FAR = "9223372036854775807";
  const FIRST_PENDING = "0123";

  async function instance(db: Database) {
    const [person] = await db
      .insertInto("users")
      .values({
        email: `numbers-${randomBytes(4).toString("hex")}@example.com`,
        displayName: "Owner",
      })
      .returning("id")
      .execute();
    const userId = person?.id ?? "";
    const baseId = (await insertBase(db, userId, { name: "Essais" })).id;
    const make = async (name: string) => {
      const { id } = await insertTable(db, userId, {
        baseId,
        name,
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const { physicalName } = await db
        .selectFrom("dataTables")
        .select("physicalName")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const context: WriteContext = {
        userId,
        tableId: id,
        physicalName,
        baseId,
        reason: null,
        source: "test",
        // A catalog this old has no queue to send row events to.
        events: false,
      };
      return { id, physicalName, context };
    };
    return { userId, baseId, make };
  }

  const add = async (
    db: Database,
    table: { id: string; context: WriteContext },
    titles: readonly string[],
  ) => {
    const { engine } = await loadEngine(db, table.id, () => true);
    return insertRows(
      db,
      engine,
      table.context,
      titles.map((title) => ({ title })),
    );
  };

  /** A row's status, moved as the application moves it. */
  async function moveStatus(
    db: Database,
    userId: string,
    table: { id: string; physicalName: string },
    rowId: string,
    steps: ReadonlyArray<"submit" | "lock" | "sign">,
  ) {
    const reached = { submit: "submitted", lock: "locked", sign: "signed" };
    for (const action of steps) {
      await withAudit(db, { userId, tableId: table.id, action }, (tx) =>
        sql`update ${sql.table(table.physicalName)} set "ag_status" = ${reached[action]} where "id" = ${rowId}`.execute(
          tx,
        ),
      );
    }
    if (steps.includes("sign")) {
      await db
        .insertInto("rowSignatures")
        .values({
          userId,
          tableId: table.id,
          recordId: rowId,
          displayName: "Owner",
          meaning: "Reviewed",
        })
        .execute();
    }
  }

  /** Everything a table holds, and whether anything rewrote its rows. */
  async function fingerprint(db: Database, physical: string) {
    const { rows } = await sql<{ print: string }>`
      select coalesce(string_agg(ctid::text || xmin::text || to_jsonb(t)::text, '|' order by "ag_seq"), '') as print
      from ${sql.table(physical)} t`.execute(db);
    return rows[0]?.print;
  }

  const sequences = async (db: Database, physical: string) => {
    const shared = await sql<{ last: string; called: boolean }>`
      select last_value::text as last, is_called as called from ag_row_position`.execute(
      db,
    );
    const name = await sql<{ name: string }>`
      select pg_get_serial_sequence(${`"${physical}"`}, 'ag_seq') as name`.execute(
      db,
    );
    const own = await sql<{ last: string; called: boolean }>`
      select last_value::text as last, is_called as called from ${sql.raw(name.rows[0]?.name ?? "")}`.execute(
      db,
    );
    return { shared: shared.rows[0], own: own.rows[0] };
  };

  it("repairs what ran out, keeps the order and every other value of each row", async () => {
    const { db, pool, close } = await catalogBefore(FIRST_PENDING);
    await lendStructure(pool);
    try {
      const { userId, make } = await instance(db);
      const other = await make("Other");
      const hit = await make("Hit");
      await add(db, other, ["other before"]);
      const [low, first, gone, second] = await add(db, hit, [
        "low",
        "first",
        "gone",
        "second",
      ]);
      await deleteRows(db, hit.context, [gone ?? ""]);
      // One far row deleted: it comes back from the trail after the repair.
      const farGone = await withAudit(
        db,
        { userId, tableId: hit.id },
        async (tx) =>
          (
            await sql<{
              id: string;
            }>`insert into ${sql.table(hit.physicalName)} ("title", "ag_seq", "ag_position") values ('far gone', ${FAR}::bigint - 3, ${FAR}::numeric - 3) returning "id"`.execute(
              tx,
            )
          ).rows[0]?.id,
      );
      await withAudit(db, { userId, tableId: hit.id }, async (tx) => {
        await sql`update ${sql.table(hit.physicalName)} set "ag_position" = -9223372036854775807 where "id" = ${low}`.execute(
          tx,
        );
        await sql`insert into ${sql.table(hit.physicalName)} ("title", "ag_seq", "ag_position") values ('far one', ${FAR}::bigint - 2, ${FAR}::numeric - 1), ('far two', ${FAR}::bigint - 1, ${FAR}::numeric), ('far locked', ${FAR}::bigint, ${FAR}::numeric - 2)`.execute(
          tx,
        );
      });
      const { rows: seqBefore } = await sql<{ id: string }>`
        select "id" from ${sql.table(hit.physicalName)} where "title" = 'far locked'`.execute(
        db,
      );
      const farLocked = seqBefore[0]?.id ?? "";
      await moveStatus(db, userId, hit, farLocked, ["submit", "lock"]);
      await moveStatus(db, userId, hit, second ?? "", [
        "submit",
        "lock",
        "sign",
      ]);
      await deleteRows(db, hit.context, [farGone ?? ""]);
      await sql`select setval(pg_get_serial_sequence(${`"${hit.physicalName}"`}, 'ag_seq'), ${FAR}::bigint)`.execute(
        db,
      );
      await sql`select setval('ag_row_position', ${FAR}::bigint)`.execute(db);
      await expect(add(db, other, ["refused"])).rejects.toThrow();

      const read = async () =>
        (
          await sql<{
            id: string;
            title: string;
            seq: string;
            position: string;
            rest: Record<string, unknown>;
          }>`select "id", "title", "ag_seq"::text as "seq", "ag_position"::text as "position", (to_jsonb(t) - 'ag_seq' - 'ag_position') as "rest" from ${sql.table(hit.physicalName)} t order by "ag_position", "ag_seq"`.execute(
            db,
          )
        ).rows;
      const before = await read();
      const trail = async () =>
        Number(
          (
            await sql<{
              count: string;
            }>`select count(*) as count from audit_events where table_id = ${hit.id}`.execute(
              db,
            )
          ).rows[0]?.count,
        );
      const eventsBefore = await trail();
      const signaturesBefore = await db
        .selectFrom("rowSignatures")
        .selectAll()
        .where("tableId", "=", hit.id)
        .execute();

      await takeBackStructure(pool);
      await migrateDb(pool);

      const after = await read();
      // The same rows, in the same order, each with all it held.
      expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
      expect(after.map((row) => row.rest)).toEqual(
        before.map((row) => row.rest),
      );
      const limit = 2n ** 53n;
      for (const row of after) {
        expect(BigInt(row.seq)).toBeLessThan(limit);
        expect(Math.abs(Number(row.position))).toBeLessThan(Number(limit));
      }
      // Those in range did not move at all.
      for (const title of ["first"]) {
        const was = before.find((row) => row.title === title);
        const is = after.find((row) => row.title === title);
        expect([is?.seq, is?.position]).toEqual([was?.seq, was?.position]);
      }
      expect(first).toBeDefined();
      // The repair wrote nothing to the trail or to the signatures.
      expect(await trail()).toBe(eventsBefore);
      expect(
        await db
          .selectFrom("rowSignatures")
          .selectAll()
          .where("tableId", "=", hit.id)
          .execute(),
      ).toEqual(signaturesBefore);
      const enabled = await sql<{ name: string; state: string }>`
        select tgname as name, tgenabled as state from pg_trigger
        where tgrelid = ${`"${hit.physicalName}"`}::regclass and not tgisinternal`.execute(
        db,
      );
      expect(enabled.rows.map((row) => row.state)).toEqual(["O", "O"]);

      // Every table takes new rows again, each after its others.
      await expect(add(db, other, ["other after"])).resolves.toHaveLength(1);
      const [added] = await add(db, hit, ["added"]);
      const placed = await read();
      expect(placed.at(-1)?.id).toBe(added);
      // A number the trail still holds is not given to a new row.
      const { rows: lastRow } = await sql<{ seq: string }>`
        select "ag_seq"::text as seq from ${sql.table(hit.physicalName)} where "id" = ${added}`.execute(
        db,
      );
      const deleted = await sql<{ seq: string }>`
        select max((old_value->>'ag_seq')::numeric)::text as seq from audit_events
        where table_id = ${hit.id} and action = 'delete' and (old_value->>'ag_seq')::numeric < 4503599627370496`.execute(
        db,
      );
      expect(BigInt(lastRow[0]?.seq ?? "0")).toBeGreaterThan(
        BigInt(deleted.rows[0]?.seq ?? "0"),
      );

      // Rows deleted before the repair come back, in range.
      const { engine } = await loadEngine(db, hit.id, () => true);
      await restoreRows(db, engine, hit.context, [gone ?? "", farGone ?? ""]);
      const back = await read();
      for (const row of back) {
        expect(BigInt(row.seq)).toBeLessThan(limit);
        expect(Math.abs(Number(row.position))).toBeLessThan(Number(limit));
      }
      expect(back.map((row) => row.title)).toEqual(
        expect.arrayContaining(["gone", "far gone"]),
      );

      // A locked row is as locked as it was.
      await expect(
        updateRows(db, engine, hit.context, [
          { rowId: farLocked, values: { title: "written" } },
        ]),
      ).rejects.toMatchObject({ code: "row_locked" });
    } finally {
      await close();
    }
  }, 60_000);

  it("leaves a healthy instance exactly as it was", async () => {
    const { db, pool, close } = await catalogBefore(FIRST_PENDING);
    await lendStructure(pool);
    try {
      const { userId, make } = await instance(db);
      const table = await make("Healthy");
      const [draft, locked] = await add(db, table, ["draft", "locked", "more"]);
      expect(draft).toBeDefined();
      await moveStatus(db, userId, table, locked ?? "", ["submit", "lock"]);
      const rows = await fingerprint(db, table.physicalName);
      const numbers = await sequences(db, table.physicalName);
      const events =
        await sql`select count(*) as count, max(occurred_at) as last from audit_events`.execute(
          db,
        );
      await takeBackStructure(pool);
      await migrateDb(pool);
      expect(await fingerprint(db, table.physicalName)).toBe(rows);
      expect(await sequences(db, table.physicalName)).toEqual(numbers);
      expect(
        (
          await sql`select count(*) as count, max(occurred_at) as last from audit_events`.execute(
            db,
          )
        ).rows,
      ).toEqual(events.rows);
    } finally {
      await close();
    }
  }, 60_000);
});

// A migration may refuse a database (ADR 0106): it asks before any
// pending migration runs, so that a refusal changes nothing.
describe("a migration that asks before it runs", () => {
  const first = {
    "0000_things.sql": "create table things (id int primary key);",
  };
  const next = {
    ...first,
    "0001_more.sql": "alter table things add column label text;",
    "0002_fewer.sql": "alter table things drop column id;",
    "0002_fewer.check.sql": `
      do $$ begin
        if exists (select 1 from things) then
          raise exception 'Empty the things first';
        end if;
      end $$;`,
  };

  it("refuses before the first pending migration, then runs them all", async () => {
    const { db, pool, close } = await emptyDatabase();
    const [before, after] = await Promise.all([
      migrationsOf(first),
      migrationsOf(next),
    ]);
    try {
      expect(await migrateDb(pool, before)).toEqual(["0000_things"]);
      await sql`insert into things values (1)`.execute(db);

      const refused = await migrateDb(pool, after).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(UpgradeRefused);
      expect((refused as UpgradeRefused).migration).toBe("0002_fewer");
      expect((refused as UpgradeRefused).message).toContain(
        "before anything was changed: Empty the things first",
      );
      // Not even the migration before the one that asked.
      expect(await appliedTo(db)).toEqual(["0000_things"]);
      // The version before starts on it again.
      expect(await migrateDb(pool, before)).toEqual([]);

      await sql`delete from things`.execute(db);
      expect(await migrateDb(pool, after)).toEqual(["0001_more", "0002_fewer"]);
    } finally {
      await close();
      await rm(before, { recursive: true, force: true });
      await rm(after, { recursive: true, force: true });
    }
  });

  it("asks nothing of a database that holds nothing", async () => {
    const { pool, close } = await emptyDatabase();
    // Asked, the check would fail: its table is not made yet.
    const folder = await migrationsOf(next);
    try {
      expect(await migrateDb(pool, folder)).toEqual([
        "0000_things",
        "0001_more",
        "0002_fewer",
      ]);
    } finally {
      await close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("refuses a check that writes", async () => {
    const { db, pool, close } = await emptyDatabase();
    const [before, after] = await Promise.all([
      migrationsOf(first),
      migrationsOf({
        ...first,
        "0001_more.sql": "alter table things add column label text;",
        "0001_more.check.sql": "insert into things values (2);",
      }),
    ]);
    try {
      await migrateDb(pool, before);
      await expect(migrateDb(pool, after)).rejects.toBeInstanceOf(
        UpgradeRefused,
      );
      const rows = await sql`select id from things`.execute(db);
      expect(rows.rows).toEqual([]);
      expect(await appliedTo(db)).toEqual(["0000_things"]);
    } finally {
      await close();
      await rm(before, { recursive: true, force: true });
      await rm(after, { recursive: true, force: true });
    }
  });
});

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

/** A catalog as it was before `upTo`, with a source of each engine. */
async function withSources(
  engines: readonly string[],
  upTo = "0116",
): Promise<Awaited<ReturnType<typeof catalogBefore>> & { owner: string }> {
  const created = await catalogBefore(upTo);
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

describe("a catalog that holds a source of a store no longer read", () => {
  it("refuses to upgrade, says why, and leaves the version before able to start", async () => {
    // As the first published version left it: the migration before the
    // one that refuses is pending too.
    const { db, pool, close, owner } = await withSources(
      ["postgres", "redis"],
      "0115",
    );
    const before = await migrationsBefore("0115");
    try {
      const was = await appliedTo(db);
      const refused = await migrateDb(pool).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(UpgradeRefused);
      expect((refused as UpgradeRefused).message).toContain(
        "no longer reads Redis, Cassandra, or Neo4j",
      );
      const kept = await sql<{ engine: string }>`
        select engine::text as engine from sources order by engine::text
      `.execute(db);
      expect(kept.rows.map((row) => row.engine)).toEqual(["postgres", "redis"]);
      expect(await appliedTo(db)).toEqual(was);
      // The version before starts again, and its administrator deletes
      // the source: the upgrade then runs whole.
      expect(await migrateDb(pool, before)).toEqual([]);
      await withAudit(db, { userId: owner, source: "web" }, (tx) =>
        sql`delete from sources where engine::text = 'redis'`.execute(tx),
      );
      const ran = await migrateDb(pool);
      expect(ran.slice(0, 2)).toEqual([
        "0115_automation_secrets",
        "0116_fewer_copy_stores",
      ]);
    } finally {
      await close();
      await rm(before, { recursive: true, force: true });
    }
  });

  it("is refused by the migration itself when nothing asked before it", async () => {
    const { db, pool, close } = await withSources(["cassandra"]);
    // Every migration, and no check.
    const unasked = await migrationsBefore("9999");
    try {
      await rm(join(unasked, "0116_fewer_copy_stores.check.sql"));
      const refused = await migrateDb(pool, unasked).catch(
        (error: unknown) => error,
      );
      expect(refused).not.toBeInstanceOf(UpgradeRefused);
      expect(String((refused as Error).cause)).toContain(
        "no longer reads Redis, Cassandra, or Neo4j",
      );
      const applied = await appliedTo(db);
      expect(applied.at(-1)).toBe("0115_automation_secrets");
    } finally {
      await close();
      await rm(unasked, { recursive: true, force: true });
    }
  });

  it("keeps the sources it still reads, and takes no such store again", async () => {
    const { db, pool, close, owner } = await withSources([
      "postgres",
      "mongodb",
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

// A SQLite file is no longer a source (ADR 0107): the upgrade asks
// before it runs, from the catalog either published version left.
describe("a catalog that holds a SQLite source", () => {
  it.each([
    ["the first version", "0115"],
    ["the version before", "0118"],
  ])(
    "refuses to upgrade from %s, changes nothing, then takes the catalog without it",
    async (_version, upTo) => {
      const { db, pool, close, owner } = await withSources(
        ["postgres", "sqlite"],
        upTo,
      );
      const before = await migrationsBefore(upTo);
      try {
        const was = await appliedTo(db);
        const refused = await migrateDb(pool).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(UpgradeRefused);
        expect((refused as UpgradeRefused).migration).toBe(
          "0118_sqlite_source_removed",
        );
        expect((refused as UpgradeRefused).message).toContain(
          "no longer reads a SQLite file",
        );
        expect(await appliedTo(db)).toEqual(was);
        // The version before starts again, and its administrator
        // deletes the source.
        expect(await migrateDb(pool, before)).toEqual([]);
        await withAudit(db, { userId: owner, source: "web" }, (tx) =>
          sql`delete from sources where engine::text = 'sqlite'`.execute(tx),
        );
        const ran = await migrateDb(pool);
        expect(ran).toContain("0118_sqlite_source_removed");
        const kept = await sql<{ engine: string }>`
          select engine::text as engine from sources
        `.execute(db);
        expect(kept.rows.map((row) => row.engine)).toEqual(["postgres"]);
        await expect(
          sql`select 'sqlite'::source_engine`.execute(db),
        ).rejects.toThrow(/invalid input value for enum source_engine/);
        // A change of a source is still on the trail.
        await withAudit(db, { userId: owner, source: "web" }, (tx) =>
          sql`update sources set host = 'other.example.org'`.execute(tx),
        );
        const trail = await sql<{ count: string }>`
          select count(*)::text as count from audit_events
          where catalog_table = 'sources'
            and new_value ->> 'host' = 'other.example.org'
        `.execute(db);
        expect(trail.rows[0]?.count).toBe("1");
      } finally {
        await close();
        await rm(before, { recursive: true, force: true });
      }
    },
  );

  it("is refused by the migration itself when nothing asked before it", async () => {
    const { db, pool, close } = await withSources(["sqlite"], "0118");
    const unasked = await migrationsBefore("9999");
    try {
      await rm(join(unasked, "0118_sqlite_source_removed.check.sql"));
      const refused = await migrateDb(pool, unasked).catch(
        (error: unknown) => error,
      );
      expect(refused).not.toBeInstanceOf(UpgradeRefused);
      expect(String((refused as Error).cause)).toContain(
        "no longer reads a SQLite file",
      );
      expect((await appliedTo(db)).at(-1)).toBe("0117_syslog_collector");
    } finally {
      await close();
      await rm(unasked, { recursive: true, force: true });
    }
  });
});

describe("notification preferences on a catalog that had one email switch", () => {
  it("keeps notices in the app for whoever had email off, and only them", async () => {
    const { db, pool, close } = await catalogBefore(
      "0135_person_notification_preferences",
    );
    try {
      const { rows } = await pool.query<{ id: string; name: string }>(
        `insert into users (email, display_name, notify_by_email)
         values ($1, 'quiet', false), ($2, 'mailed', true)
         returning id, display_name as name`,
        [`quiet-${suffix}@example.com`, `mailed-${suffix}@example.com`],
      );
      const id = (name: string) =>
        rows.find((row) => row.name === name)?.id ?? "";

      const ran = await migrateDb(pool);
      expect(ran[0]).toBe("0135_person_notification_preferences");
      const kept = await db
        .selectFrom("notificationPreferences")
        .select(["userId", "event", "channels"])
        .where("userId", "in", [id("quiet"), id("mailed")])
        .execute();
      expect(kept.every((row) => row.userId === id("quiet"))).toBe(true);
      expect(kept.map((row) => row.event)).toContain("mention");
      expect(
        kept.every((row) => JSON.stringify(row.channels) === '["in_app"]'),
      ).toBe(true);
      // The switch is gone, and a list that is not one is refused.
      await expect(
        pool.query(
          `insert into notification_preferences (user_id, event, channels)
           values ($1, 'reply', '["fax"]')`,
          [id("mailed")],
        ),
      ).rejects.toThrow(/notification_preferences_channels/);
    } finally {
      await close();
    }
  });
});

describe("the lock of an account on a catalog that had two switches for it", () => {
  it("keeps it off for whoever turned it off in Administration, and only that", async () => {
    const { db, pool, close } = await catalogBefore(
      "0148_lock_alert_preference",
    );
    try {
      const { rows } = await pool.query<{ id: string; name: string }>(
        `insert into users (email, display_name, is_admin)
         values ($1, 'spared', true), ($2, 'mailed', true), ($3, 'told', true)
         returning id, display_name as name`,
        [
          `spared-${suffix}@example.com`,
          `mailed-${suffix}@example.com`,
          `told-${suffix}@example.com`,
        ],
      );
      const id = (name: string) =>
        rows.find((row) => row.name === name)?.id ?? "";
      // Spared a lock and a late backup; spared a lock though mailed one.
      await pool.query(
        `insert into alert_optouts (user_id, kind)
         values ($1, 'account_locked'), ($1, 'backup_late'), ($2, 'account_locked')`,
        [id("spared"), id("mailed")],
      );
      await pool.query(
        `insert into notification_preferences (user_id, event, channels)
         values ($1, 'account_locked', '["email_immediate"]'),
                ($2, 'account_locked', '["in_app"]')`,
        [id("mailed"), id("told")],
      );

      const ran = await migrateDb(pool);
      expect(ran[0]).toBe("0148_lock_alert_preference");
      const kept = await db
        .selectFrom("notificationPreferences")
        .select(["userId", "channels"])
        .where("event", "=", "account_locked")
        .where("userId", "in", [id("spared"), id("mailed"), id("told")])
        .execute();
      const channels = (name: string) =>
        JSON.stringify(kept.find((row) => row.userId === id(name))?.channels);
      expect([
        channels("spared"),
        channels("mailed"),
        channels("told"),
      ]).toEqual(["[]", "[]", '["in_app"]']);
      const left = await db
        .selectFrom("alertOptouts")
        .select(["userId", "kind"])
        .where("userId", "in", [id("spared"), id("mailed")])
        .execute();
      expect(left).toEqual([{ userId: id("spared"), kind: "backup_late" }]);
      // The lock is no alert choice any more.
      await expect(
        pool.query(
          `insert into alert_optouts (user_id, kind) values ($1, 'account_locked')`,
          [id("told")],
        ),
      ).rejects.toThrow(/alert_optouts_kind_check/);
    } finally {
      await close();
    }
  });
});

describe("one journal of deliveries on a catalog that kept two", () => {
  it("moves a webhook's and a channel's deliveries, each with its id", async () => {
    const { db, pool, close } = await catalogBefore("0139");
    try {
      const { id: owner } = await db
        .insertInto("users")
        .values({ email: `hooks-${suffix}@example.com`, displayName: "Hooks" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const { id: baseId } = await insertBase(db, owner, { name: "Hooks" });
      const table = await insertTable(db, owner, {
        baseId,
        name: "Orders",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const hook = await withAudit(
        db,
        { userId: owner, tableId: table.id, source: "web" },
        (tx) =>
          tx
            .insertInto("webhooks")
            .values({
              tableId: table.id,
              kind: "http",
              target: "https://hooks.example.com/in",
              events: ["insert"],
              secretCiphertext: Buffer.from("sealed"),
              secretNonce: Buffer.from("nonce"),
            })
            .returning("id")
            .executeTakeFirstOrThrow(),
      );
      const channel = await db
        .insertInto("instanceIntegrations")
        .values({ name: "Ops", provider: "ntfy" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const sent = "44444444-4444-4444-8444-444444444444";
      const told = "55555555-5555-4555-8555-555555555555";
      const event = "66666666-6666-4666-8666-666666666666";
      await pool.query(
        `insert into webhook_deliveries
           (id, webhook_id, event, row_id, status, attempts, error, payload)
         values ($1, $2, 'insert', 'row-1', 'failed', 4, 'HTTP 503',
                 '{"id": "kept"}')`,
        [sent, hook.id],
      );
      await pool.query(
        `insert into integration_deliveries
           (id, integration_id, event_id, event, subject, fields, status, attempts)
         values ($1, $2, $3, 'job.failed', 'job-1', '{"kind": "export"}',
                 'pending', 1)`,
        [told, channel.id, event],
      );

      expect((await migrateDb(pool))[0]).toBe("0139_deliveries");
      const moved = await db
        .selectFrom("deliveries")
        .selectAll()
        .orderBy("origin", "desc")
        .execute();
      expect(moved).toMatchObject([
        {
          id: sent,
          origin: "webhook",
          webhookId: hook.id,
          integrationId: null,
          rowId: "row-1",
          status: "failed",
          attempts: 4,
          error: "HTTP 503",
          payload: { id: "kept" },
        },
        {
          id: told,
          origin: "integration",
          webhookId: null,
          integrationId: channel.id,
          eventId: event,
          subject: "job-1",
          status: "pending",
          attempts: 1,
          payload: { kind: "export" },
          // Its next attempt is its queued job's, not the sweep's to guess.
          nextAttemptAt: null,
        },
      ]);
      const { rows } = await pool.query<{ hooks: string | null }>(
        `select to_regclass('webhook_deliveries')::text as hooks,
                to_regclass('integration_deliveries')::text as channels`,
      );
      expect(rows[0]).toEqual({ hooks: null, channels: null });
    } finally {
      await close();
    }
  });
});
