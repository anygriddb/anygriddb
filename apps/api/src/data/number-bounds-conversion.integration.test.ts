/**
 * Migration 0160 (ADR 0141): a number field that refused negative numbers,
 * as 0.14 kept it, takes a smallest value of 0, and the old key goes from
 * every field that held it, a trashed one included; nothing else changes.
 */
import { migrateDb } from "@anygriddb/db";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { catalogBefore } from "./catalog-before.test-helpers.js";
import { insertBase, insertTable } from "./schema-ops.js";

describe("a number's bounds from the setting before them", () => {
  it("turns a refusal of negatives into a smallest value of 0, and drops the key", async () => {
    const { db, pool, close } = await catalogBefore("0160");
    try {
      const { rows } = await sql<{ id: string }>`
        insert into users (email, display_name)
        values ('ada@example.org', 'Ada') returning id
      `.execute(db);
      const ada = rows[0]?.id ?? "";
      const configs = {
        stock: { nonNegative: true, number: { precision: 2 } },
        trashed: { nonNegative: true },
        signed: { nonNegative: false, number: { style: "decimal" } },
        plain: { number: { precision: 0 } },
      };
      const base = await insertBase(db, ada, { name: "Stock" });
      const table = await insertTable(db, ada, {
        baseId: base.id,
        name: "Items",
        columns: Object.keys(configs).map((name) => ({
          name,
          label: name,
          fieldType: "number" as const,
        })),
      });
      // Each field's settings as 0.14 wrote them, one of them trashed.
      await db.transaction().execute(async (tx) => {
        await sql`
          select set_config('anygrid.user_id', ${ada}, true),
            set_config('anygrid.source', 'test', true)
        `.execute(tx);
        for (const [name, config] of Object.entries(configs)) {
          await sql`
            update data_columns
            set config = ${JSON.stringify(config)}::jsonb,
              deleted_at = ${name === "trashed" ? sql`now()` : sql`null`}
            where table_id = ${table.id} and name = ${name}
          `.execute(tx);
        }
      });

      await migrateDb(pool);

      const after = await db
        .selectFrom("dataColumns")
        .select(["name", "config"])
        .where("tableId", "=", table.id)
        .where("name", "in", Object.keys(configs))
        .orderBy("name")
        .execute();
      expect(
        Object.fromEntries(after.map((row) => [row.name, row.config])),
      ).toEqual({
        plain: { number: { precision: 0 } },
        signed: { number: { style: "decimal" } },
        stock: { min: "0", number: { precision: 2 } },
        trashed: { min: "0" },
      });
    } finally {
      await close();
    }
  }, 120_000);
});
