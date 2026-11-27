/**
 * The tokens of a version before delegated accesses (ADR 0131, §5), moved
 * by migration 0155 into `delegated_accesses` row for row: ids, dates and
 * hashes kept, what a token was kept from turned into what it is
 * entrusted, an application's refresh token still renewing its grant.
 */
import { PERMISSIONS, rolePermissions } from "@anygriddb/core";
import { migrateDb } from "@anygriddb/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { catalogBefore } from "../data/catalog-before.test-helpers.js";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const BASE = "01a00000-0000-7000-8000-000000000001";

describe("delegated accesses from the tables before them", () => {
  it("moves every token row for row, and keeps what each was kept from", async () => {
    const { db, pool, close } = await catalogBefore("0155");
    try {
      const { rows: people } = await sql<{ id: string }>`
        insert into users (email, display_name)
        values ('ada@example.org', 'Ada'), ('bea@example.org', 'Bea')
        returning id
      `.execute(db);
      const [ada, bea] = people.map((row) => row.id);
      const ends = new Date("2027-01-01T00:00:00Z");
      const used = new Date("2026-11-01T00:00:00Z");
      const ids = await db.transaction().execute(async (tx) => {
        await sql`
          select set_config('anygrid.user_id', ${ada}, true),
            set_config('anygrid.source', 'test', true)
        `.execute(tx);
        const { rows: clients } = await sql<{ id: string }>`
          insert into oauth_clients (client_id, name, secret_hash, redirect_uris, created_by)
          values ('agc_example', 'Planner', 'x', array['https://app.example.org/cb'], ${ada})
          returning id
        `.execute(tx);
        const client = clients[0]?.id ?? "";
        const token = async (values: {
          user: string | undefined;
          name: string;
          n: number;
          readOnly?: boolean;
          allowDelete?: boolean;
          baseIds?: string;
          client?: string;
        }) =>
          (
            await sql<{ id: string }>`
              insert into api_tokens (user_id, name, token_hash, expires_at,
                read_only, allow_delete, base_ids, oauth_client_id, last_used_at)
              values (${values.user}, ${values.name}, ${hash(values.n)}, ${ends},
                ${values.readOnly ?? false}, ${values.allowDelete ?? true},
                ${values.baseIds ?? null}::jsonb, ${values.client ?? null}, ${used})
              returning id
            `.execute(tx)
          ).rows[0]?.id ?? "";
        const plain = await token({ user: ada, name: "Script", n: 1 });
        const reading = await token({
          user: ada,
          name: "Reader",
          n: 2,
          readOnly: true,
          baseIds: `["${BASE}", "not-a-base"]`,
        });
        const keeping = await token({
          user: bea,
          name: "Keeper",
          n: 3,
          allowDelete: false,
        });
        const granted = await token({
          user: bea,
          name: "OAuth: Planner",
          n: 4,
          client,
        });
        await sql`
          insert into oauth_refresh_tokens (token_hash, client_id, user_id, api_token_id, expires_at)
          values (${hash(5)}, ${client}, ${bea}, ${granted}, ${ends})
        `.execute(tx);
        const admin =
          (
            await sql<{ id: string }>`
            insert into admin_tokens (name, token_hash, scopes, created_by, expires_at)
            values ('CI', ${hash(6)}, '["settings", "accounts"]', ${ada}, ${ends})
            returning id
          `.execute(tx)
          ).rows[0]?.id ?? "";
        const scim =
          (
            await sql<{ id: string }>`
            insert into scim_tokens (name, token_hash, created_by, expires_at)
            values ('Okta', ${hash(7)}, ${ada}, ${ends})
            returning id
          `.execute(tx)
          ).rows[0]?.id ?? "";
        return { client, plain, reading, keeping, granted, admin, scim };
      });

      await migrateDb(pool);

      const moved = await db
        .selectFrom("delegatedAccesses")
        .selectAll()
        .orderBy("secretHash")
        .execute();
      expect(
        moved.map((row) => [row.id, row.kind, row.authorId, row.secretHash]),
      ).toEqual([
        [ids.plain, "api_token", ada, hash(1)],
        [ids.reading, "api_token", ada, hash(2)],
        [ids.keeping, "api_token", bea, hash(3)],
        [ids.granted, "application", bea, hash(4)],
        [ids.admin, "admin_token", ada, hash(6)],
        [ids.scim, "scim_token", ada, hash(7)],
      ]);
      const byId = new Map(moved.map((row) => [row.id, row]));
      // A plain token keeps all its author holds; read-only, a viewer's
      // part; kept from deleting, all but that.
      expect(byId.get(ids.plain)?.permissions).toBeNull();
      expect(byId.get(ids.reading)?.permissions).toEqual(
        rolePermissions("viewer"),
      );
      expect(byId.get(ids.keeping)?.permissions).toEqual(
        PERMISSIONS.filter((permission) => permission !== "rows.delete"),
      );
      // A base id kept as text that names no base is dropped.
      expect(byId.get(ids.reading)?.baseIds).toEqual([BASE]);
      expect(byId.get(ids.plain)?.baseIds).toBeNull();
      expect(byId.get(ids.granted)?.clientId).toBe(ids.client);
      expect(byId.get(ids.admin)?.permissions).toEqual([
        "settings",
        "accounts",
      ]);
      for (const row of moved) {
        expect(row.endsAt?.toISOString()).toBe(ends.toISOString());
        expect(row.revokedAt).toBeNull();
      }
      expect(byId.get(ids.plain)?.lastUsedAt?.toISOString()).toBe(
        used.toISOString(),
      );
      // The refresh token still renews its grant.
      expect(
        await db.selectFrom("oauthRefreshTokens").select("accessId").execute(),
      ).toEqual([{ accessId: ids.granted }]);
      // The tables before are gone, and nothing was written to the trail.
      const { rows: gone } = await sql<{ left: string | null }>`
        select coalesce(to_regclass('api_tokens')::text,
          to_regclass('admin_tokens')::text, to_regclass('scim_tokens')::text) as left
      `.execute(db);
      expect(gone[0]?.left).toBeNull();
      expect(
        await db
          .selectFrom("auditEvents")
          .select("id")
          .where("catalogTable", "=", "delegated_accesses")
          .execute(),
      ).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);
});
