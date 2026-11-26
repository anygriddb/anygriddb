/**
 * The permissions a made role may give are written twice: in the code
 * (`PERMISSIONS`) and in the database's check on `made_roles.permissions`.
 * They are held to each other here (ADR 0131): a permission added to one
 * and not the other would make a role the screens offer and the database
 * refuses, or the other way round.
 */
import { PERMISSIONS } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";

describe("the catalogue of a made role's permissions", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase("made_roles_catalogue");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("allows exactly the permissions the code names", async () => {
    const { rows } = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'made_roles_permissions_check'
    `.execute(db);
    const definition = rows[0]?.definition ?? "";
    const allowed = definition.match(/<@ '(\[[^']*\])'/)?.[1];
    expect(allowed, definition).toBeDefined();
    const listed = JSON.parse(allowed ?? "[]") as string[];
    expect([...listed].sort()).toEqual([...PERMISSIONS].sort());
    // And every made role reads rows.
    expect(definition).toContain(`@> '["rows.read"]'`);
  });
});
