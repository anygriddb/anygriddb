/**
 * Calendar feeds, public links and an automation's inbound secret of a
 * version before them, moved by migration 0156 into `delegated_accesses`
 * row for row: ids, dates and hashes kept, a link's settings and password
 * kept, a file a form sent still waiting on its link.
 */
import { migrateDb } from "@anygriddb/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { catalogBefore } from "../data/catalog-before.test-helpers.js";
import { insertBase, insertTable } from "../data/schema-ops.js";

const hash = (n: number) => n.toString(16).padStart(64, "0");

describe("feeds, links and inbound secrets from the tables before them", () => {
  it("moves each row for row, and drops a secret no author runs", async () => {
    const { db, pool, close } = await catalogBefore("0156");
    try {
      const { rows: people } = await sql<{ id: string }>`
        insert into users (email, display_name)
        values ('ada@example.org', 'Ada'), ('bea@example.org', 'Bea')
        returning id
      `.execute(db);
      const [ada = "", bea = ""] = people.map((row) => row.id);
      const base = await insertBase(db, ada, { name: "Lab" });
      const table = await insertTable(db, ada, {
        baseId: base.id,
        name: "Things",
        columns: [{ name: "title", fieldType: "text", label: "Title" }],
      });
      const view = await db
        .selectFrom("views")
        .select("id")
        .where("tableId", "=", table.id)
        .executeTakeFirstOrThrow();
      const ends = new Date("2027-01-01T00:00:00Z");
      const ids = await db.transaction().execute(async (tx) => {
        await sql`
          select set_config('anygrid.user_id', ${ada}, true),
            set_config('anygrid.source', 'test', true)
        `.execute(tx);
        const one = async (query: ReturnType<typeof sql<{ id: string }>>) =>
          (await query.execute(tx)).rows[0]?.id ?? "";
        const feed = await one(sql<{ id: string }>`
          insert into calendar_feeds (view_id, user_id, token_hash, last_used_at)
          values (${view.id}, ${bea}, ${hash(1)}, ${ends}) returning id
        `);
        const viewLink = await one(sql<{ id: string }>`
          insert into shares (view_id, token_hash, password_hash, allow_copy,
            created_by, expires_at, embed_origins, password_failures)
          values (${view.id}, ${hash(2)}, 'argon-of-a-password', true, ${ada},
            ${ends}, '["https://site.example.org"]', 3) returning id
        `);
        const baseLink = await one(sql<{ id: string }>`
          insert into shares (base_id, token_hash, allow_copy, created_by, revoked_at)
          values (${base.id}, ${hash(3)}, false, ${ada}, ${ends}) returning id
        `);
        const hooked = await one(sql<{ id: string }>`
          insert into automations (table_id, name, trigger, actions, created_by, webhook_token_hash)
          values (${table.id}, 'Hook', '{"type": "webhook"}', '[]', ${bea}, ${hash(4)})
          returning id
        `);
        const orphan = await one(sql<{ id: string }>`
          insert into automations (table_id, name, trigger, actions, created_by, webhook_token_hash)
          values (${table.id}, 'Orphan', '{"type": "webhook"}', '[]', null, ${hash(5)})
          returning id
        `);
        await sql`
          insert into attachments (key, filename, mime, size, table_id,
            created_by, staged_share_id, staged_until)
          values ('staged/a', 'a.txt', 'text/plain', 1, ${table.id}, null,
            ${viewLink}, ${ends})
        `.execute(tx);
        return { feed, viewLink, baseLink, hooked, orphan };
      });

      await migrateDb(pool);

      const moved = await db
        .selectFrom("delegatedAccesses")
        .selectAll()
        .orderBy("secretHash")
        .execute();
      expect(
        moved.map((row) => [row.kind, row.authorId, row.secretHash]),
      ).toEqual([
        ["feed", bea, hash(1)],
        ["link", ada, hash(2)],
        ["link", ada, hash(3)],
        ["inbound_hook", bea, hash(4)],
      ]);
      const [feed, viewLink, baseLink, hook] = moved;
      expect(feed).toMatchObject({
        id: ids.feed,
        viewId: view.id,
        endsAt: null,
        revokedAt: null,
      });
      expect(feed?.lastUsedAt?.toISOString()).toBe(ends.toISOString());
      expect(viewLink).toMatchObject({
        id: ids.viewLink,
        viewId: view.id,
        baseId: null,
        allowCopy: true,
        embedOrigins: ["https://site.example.org"],
        passwordHash: "argon-of-a-password",
        passwordFailures: 3,
      });
      expect(viewLink?.endsAt?.toISOString()).toBe(ends.toISOString());
      expect(baseLink).toMatchObject({
        id: ids.baseLink,
        viewId: null,
        baseId: base.id,
        allowCopy: false,
      });
      expect(baseLink?.revokedAt?.toISOString()).toBe(ends.toISOString());
      expect(hook).toMatchObject({ automationId: ids.hooked, viewId: null });
      // The file a form sent still waits on its link.
      expect(
        await db
          .selectFrom("attachments")
          .select("stagedShareId")
          .where("key", "=", "staged/a")
          .executeTakeFirstOrThrow(),
      ).toEqual({ stagedShareId: ids.viewLink });
      // The tables and the column before are gone; nothing went on the trail.
      const { rows: gone } = await sql<{ left: string | null; column: number }>`
        select coalesce(to_regclass('calendar_feeds')::text,
          to_regclass('shares')::text) as left,
          (select count(*)::int from information_schema.columns
            where table_name = 'automations'
              and column_name = 'webhook_token_hash') as column
      `.execute(db);
      expect(gone[0]).toEqual({ left: null, column: 0 });
      expect(
        await db
          .selectFrom("auditEvents")
          .select("id")
          .where("catalogTable", "=", "delegated_accesses")
          .execute(),
      ).toEqual([]);
      // The automation without an author keeps running nothing, and has no
      // secret to start it.
      expect(ids.orphan).not.toBe("");
    } finally {
      await close();
    }
  }, 120_000);
});
