/**
 * What an administrator relaxed (ADR 0140): migration 0159 moves a
 * source's clear connection and the private networks' setting into one
 * table; relaxing and going back write the trail once each; a source
 * manager keeps a source relaxed and relaxes none; a source's relaxation
 * goes with it.
 */
import { randomBytes } from "node:crypto";
import { migrateDb, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { giveInstanceRole } from "./auth/instance-roles.test-helpers.js";
import { keyRing } from "./auth/key-ring.js";
import { withAudit } from "./data/audit-context.js";
import { catalogBefore } from "./data/catalog-before.test-helpers.js";
import type { Env } from "./env.js";
import { relaxationAllows, setRelaxation } from "./relaxations.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

/** A source as a version before 0159 kept it, written as SQL. */
async function olderSource(
  db: Database,
  userId: string,
  name: string,
  plaintext: boolean,
): Promise<string> {
  return db.transaction().execute(async (tx) => {
    await sql`
      select set_config('anygrid.user_id', ${userId}, true),
        set_config('anygrid.source', 'test', true)
    `.execute(tx);
    const { rows } = await sql<{ id: string }>`
      insert into sources (name, engine, host, port, database, username,
        password_ciphertext, password_nonce, allow_plaintext, created_by)
      values (${name}, 'postgres', 'db.example.org', 5432, 'app', 'reader',
        '\\x00'::bytea, '\\x00'::bytea, ${plaintext}, ${userId})
      returning id
    `.execute(tx);
    return rows[0]?.id ?? "";
  });
}

describe("relaxations from the places before them", () => {
  it("moves a source's clear connection and the private networks, then drops both", async () => {
    const { db, pool, close } = await catalogBefore("0159");
    try {
      const { rows } = await sql<{ id: string }>`
        insert into users (email, display_name)
        values ('ada@example.org', 'Ada') returning id
      `.execute(db);
      const ada = rows[0]?.id ?? "";
      const clear = await olderSource(db, ada, "Clear", true);
      await olderSource(db, ada, "Encrypted", false);
      await sql`
        insert into instance_settings (key, value, updated_by)
        values ('notifyAllowPrivate', 'true'::jsonb, ${ada})
      `.execute(db);

      await migrateDb(pool);

      const moved = await db
        .selectFrom("relaxations")
        .select(["key", "sourceId", "enabledBy", "consequence"])
        .orderBy("key")
        .execute();
      expect(moved).toEqual([
        {
          key: "notify.private_networks",
          sourceId: null,
          enabledBy: ada,
          consequence: 1,
        },
        {
          key: "source.plaintext",
          sourceId: clear,
          enabledBy: ada,
          consequence: 1,
        },
      ]);
      const setting = await db
        .selectFrom("instanceSettings")
        .select("key")
        .where("key", "=", "notifyAllowPrivate")
        .execute();
      expect(setting).toEqual([]);
      const { rows: columns } = await sql<{ name: string }>`
        select column_name as name from information_schema.columns
         where table_name = 'sources' and column_name = 'allow_plaintext'
      `.execute(db);
      expect(columns).toEqual([]);

      // Only what the catalogue holds, for what it is kept for.
      await expect(
        sql`insert into relaxations (key, consequence) values ('source.plaintext', 1)`.execute(
          db,
        ),
      ).rejects.toThrow(/relaxations_scope/);
      await expect(
        sql`insert into relaxations (key, consequence) values ('app.http', 1)`.execute(
          db,
        ),
      ).rejects.toThrow(/relaxations_key/);
      await expect(
        sql`insert into relaxations (key, consequence) values ('notify.private_networks', 1)`.execute(
          db,
        ),
      ).rejects.toThrow(/relaxations_once/);

      // A source deleted takes its relaxation along.
      await db.transaction().execute(async (tx) => {
        await sql`
          select set_config('anygrid.user_id', ${ada}, true),
            set_config('anygrid.source', 'test', true)
        `.execute(tx);
        await tx.deleteFrom("sources").where("id", "=", clear).execute();
      });
      expect(await relaxationAllows(db, "source.plaintext", clear)).toBe(false);
    } finally {
      await close();
    }
  });
});

describe("relaxing a requirement from Administration", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();
  const manager = browser();
  let adminId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("relaxations");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password: PASSWORD });
    adminId = (await admin.call().session.current())?.id ?? "";
    const managerId = await signUpProved(manager, db, {
      email: `manager-${suffix}@example.org`,
      displayName: "Bea Manager",
      password: PASSWORD,
    });
    await giveInstanceRole(db, managerId, "source_manager");
    await enrollTotp(manager);
    await manager.call().admin.stepUp({ password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  const trail = () =>
    db
      .selectFrom("authEvents")
      .select(["action", "actorId", "detail"])
      .where("action", "in", ["relaxation_enabled", "relaxation_disabled"])
      .orderBy("occurredAt")
      .orderBy("id")
      .execute();

  it("relaxes the instance once, lists it, and goes back to strict, each in the trail", async () => {
    const relaxations = () => admin.call().admin.relaxations;
    expect(await relaxations().list()).toEqual([]);
    const key = "notify.private_networks";
    await relaxations().relax({ key });
    const listed = await relaxations().relax({ key });
    expect(listed).toEqual([
      {
        key,
        source: null,
        enabledBy: { id: adminId, name: "Ada Admin" },
        enabledAt: expect.any(String),
        consequence: 1,
      },
    ]);
    expect(await relaxationAllows(db, key)).toBe(true);
    expect(await relaxations().end({ key })).toEqual([]);
    await relaxations().end({ key });
    expect(await relaxationAllows(db, key)).toBe(false);
    expect(await trail()).toEqual([
      { action: "relaxation_enabled", actorId: adminId, detail: key },
      { action: "relaxation_disabled", actorId: adminId, detail: key },
    ]);
    const changes = await db
      .selectFrom("auditEvents")
      .select(["userId", "oldValue", "newValue"])
      .where("catalogTable", "=", "relaxations")
      .orderBy("occurredAt")
      .orderBy("id")
      .execute();
    expect(changes).toEqual([
      {
        userId: adminId,
        oldValue: null,
        newValue: expect.objectContaining({ key, source_id: null }),
      },
      {
        userId: adminId,
        oldValue: expect.objectContaining({ key, source_id: null }),
        newValue: null,
      },
    ]);
  });

  it("relaxes a source only from its dialog, and names it whole", async () => {
    expect(
      await errorCode(
        admin.call().admin.relaxations.relax({ key: "source.plaintext" }),
      ),
    ).toBe("invalid_input");
    expect(
      await errorCode(
        admin.call().admin.relaxations.end({ key: "source.plaintext" }),
      ),
    ).not.toBe("ok");
  });

  it("lets a source manager keep a source relaxed and relax none", async () => {
    expect(await errorCode(manager.call().admin.relaxations.list())).toBe(
      "access_denied",
    );
    const input = {
      name: "Plain",
      engine: "postgres" as const,
      host: "db.example.org",
      port: 5432,
      database: "app",
      username: "reader",
      password: "a-password",
      allowPlaintext: true,
    };
    expect(await errorCode(manager.call().admin.sources.create(input))).toBe(
      "access_denied",
    );
    // Past the rule, the source's host is what refuses here.
    expect(await errorCode(admin.call().admin.sources.create(input))).toBe(
      "source_host_not_allowed",
    );

    const kept = await db.transaction().execute(async (tx) => {
      await sql`
        select set_config('anygrid.user_id', ${adminId}, true),
          set_config('anygrid.source', 'test', true)
      `.execute(tx);
      return tx
        .insertInto("sources")
        .values({
          name: "Kept",
          engine: "postgres",
          host: "db.example.org",
          port: 5432,
          database: "app",
          username: "reader",
          passwordCiphertext: Buffer.from([0]),
          passwordNonce: Buffer.from([0]),
          createdBy: adminId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    });
    // A password given, so that the change reads none of the stored one.
    const change = {
      id: kept.id,
      name: "Kept still",
      password: "a-password",
      allowPlaintext: true,
    };
    expect(await errorCode(manager.call().admin.sources.update(change))).toBe(
      "access_denied",
    );
    await withAudit(db, { userId: adminId, source: "test" }, (tx) =>
      setRelaxation(
        tx,
        { id: adminId },
        { key: "source.plaintext", sourceId: kept.id },
        true,
      ),
    );
    expect(await errorCode(manager.call().admin.sources.update(change))).toBe(
      "source_host_not_allowed",
    );
    const [listed] = await admin.call().admin.relaxations.list();
    expect(listed).toMatchObject({
      key: "source.plaintext",
      source: { id: kept.id, name: "Kept" },
    });
    await admin
      .call()
      .admin.relaxations.end({ key: "source.plaintext", sourceId: kept.id });
    expect(await relaxationAllows(db, "source.plaintext", kept.id)).toBe(false);
  });
});
