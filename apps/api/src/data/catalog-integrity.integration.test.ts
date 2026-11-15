/**
 * Catalog rules that live in the database: one role on an object, an
 * address that ignores case, a file and a folder that outlive the
 * account that touched them, and the pool's own limits.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
