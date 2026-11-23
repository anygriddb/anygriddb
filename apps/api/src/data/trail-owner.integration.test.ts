/**
 * What a session that does not own the trail can do to it, signed in as a
 * real role of its own, even granted the statements it tries: the flags
 * that open the trail answer to its owner alone.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@anygriddb/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";

const role = `ag_runtime_${randomBytes(5).toString("hex")}`;
const password = randomBytes(18).toString("hex");

describe("a session that does not own the trail", () => {
  let db: Database;
  let owner: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  let session: pg.Client;
  let authorId = "";
  const tableId = randomUUID();

  const newAccount = async () =>
    (
      await db
        .insertInto("users")
        .values({
          email: `trail-${randomBytes(5).toString("hex")}@example.org`,
          displayName: "Tess Trail",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const newEvent = async (userId: string, daysAgo = 0) =>
    (
      await db
        .insertInto("auditEvents")
        .values({
          userId,
          action: "update",
          tableId,
          recordId: randomUUID(),
          newValue: { name: "kept" },
          source: "web",
          occurredAt: new Date(Date.now() - daysAgo * 86_400_000),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const authorOf = async (id: string) =>
    (
      await db
        .selectFrom("auditEvents")
        .select("userId")
        .where("id", "=", id)
        .executeTakeFirst()
    )?.userId;
  /** Runs in one transaction of the session, undone unless it says keep. */
  const inTransaction = async (
    statements: ReadonlyArray<readonly [string, unknown[]?]>,
    keep = false,
  ) => {
    await session.query("begin");
    try {
      for (const [text, values] of statements) {
        await session.query(text, values);
      }
      await session.query(keep ? "commit" : "rollback");
    } catch (error) {
      await session.query("rollback");
      throw error;
    }
  };

  beforeAll(async () => {
    const created = await createTestDatabase("trail_owner");
    db = created.db;
    owner = created.owner.pool;
    close = created.close;
    await owner.query(`create role "${role}" login password '${password}'`);
    await owner.query(`grant usage on schema public to "${role}"`);
    await owner.query(
      `grant select, insert, update, delete on all tables in schema public to "${role}"`,
    );
    await owner.query(
      `grant usage on all sequences in schema public to "${role}"`,
    );
    await owner.query(
      `grant execute on function ag_purge_audit_events(integer, timestamptz, integer), ag_erase_account(uuid) to "${role}"`,
    );
    const url = new URL(created.url);
    url.username = role;
    url.password = password;
    session = new pg.Client({ connectionString: url.toString() });
    await session.connect();
  });

  beforeEach(async () => {
    authorId = await newAccount();
  });

  afterAll(async () => {
    await session.end();
    await owner.query(`drop owned by "${role}"`);
    await owner.query(`drop role "${role}"`);
    await close?.();
  });

  it("cannot delete an event, with the purge's flag or without", async () => {
    const id = await newEvent(authorId, 900);
    await expect(
      inTransaction([
        ["select set_config('anygrid.purge_audit', 'on', true)"],
        ["delete from audit_events where id = $1", [id]],
      ]),
    ).rejects.toThrow(/Audit immutable/);
    expect(await authorOf(id)).toBe(authorId);
  });

  it("cannot give an event to someone else, with the erasure's flag", async () => {
    const other = await newAccount();
    const id = await newEvent(authorId);
    await expect(
      inTransaction([
        ["select set_config('anygrid.anonymize', 'on', true)"],
        ["update audit_events set user_id = $1 where id = $2", [other, id]],
      ]),
    ).rejects.toThrow(/Audit immutable/);
    expect(await authorOf(id)).toBe(authorId);
  });

  it("cannot silence the trail of the catalog with the migrations' flag", async () => {
    await expect(
      inTransaction([
        ["select set_config('anygrid.migrate', 'on', true)"],
        ["insert into bases (name) values ('Hidden')"],
      ]),
    ).rejects.toThrow(/Audit context required/);
  });

  it("purges nothing younger than the shortest retention", async () => {
    const young = await newEvent(authorId, 100);
    const old = await newEvent(authorId, 900);
    for (const days of [0, 1, 364, 3651]) {
      await expect(
        inTransaction([
          ["select ag_purge_audit_events($1, now(), 5000)", [days]],
        ]),
      ).rejects.toThrow(/Invalid purge/);
    }
    // A date in the future does not bring the limit closer.
    await inTransaction(
      [
        [
          "select ag_purge_audit_events(365, now() + interval '10 years', 5000)",
        ],
      ],
      true,
    );
    expect(await authorOf(young)).toBe(authorId);
    expect(await authorOf(old)).toBeUndefined();
  });

  it("moves an author's events only by erasing the account", async () => {
    const id = await newEvent(authorId);
    await inTransaction(
      [
        ["select set_config('anygrid.user_id', $1, true)", [authorId]],
        ["select set_config('anygrid.reason', 'Account erasure', true)"],
        ["select ag_erase_account($1)", [authorId]],
      ],
      true,
    );
    expect(await authorOf(id)).toBe("00000000-0000-0000-0000-000000000000");
    expect(
      await db
        .selectFrom("users")
        .select("id")
        .where("id", "=", authorId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it("clears the account's addresses, and keeps who erased it", async () => {
    const admin = await newAccount();
    const address = "203.0.113.7";
    const ofEvent = async (values: {
      action: "login_success" | "account_erased";
      userId: string | null;
      actorId: string | null;
    }) =>
      (
        await db
          .insertInto("authEvents")
          .values({ ...values, ip: address })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    const signIn = await ofEvent({
      action: "login_success",
      userId: authorId,
      actorId: null,
    });
    // What this account did to another as an administrator names it too.
    const itErased = await ofEvent({
      action: "account_erased",
      userId: null,
      actorId: authorId,
    });
    const erasedBy = await ofEvent({
      action: "account_erased",
      userId: authorId,
      actorId: admin,
    });
    await inTransaction(
      [
        ["select set_config('anygrid.user_id', $1, true)", [admin]],
        ["select ag_erase_account($1)", [authorId]],
      ],
      true,
    );
    const addressOf = async (id: string) =>
      (
        await db
          .selectFrom("authEvents")
          .select("ip")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).ip;
    expect(await addressOf(signIn)).toBeNull();
    expect(await addressOf(itErased)).toBeNull();
    expect(await addressOf(erasedBy)).toBe(address);
  });

  it("cannot erase the account every erased person becomes", async () => {
    await expect(
      inTransaction([
        ["select ag_erase_account('00000000-0000-0000-0000-000000000000')"],
      ]),
    ).rejects.toThrow(/Invalid account/);
  });
});
