/**
 * How the change trail is read once it is long, against a real database:
 * Administration's first page, one account's events, and what an erasure
 * rewrites each come from an index, in its order, and never from a read
 * of every event.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { instanceAudit } from "./admin.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
};

function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

describe("the change trail, read through its indexes", () => {
  let db: Database;
  let pool: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  let ada = "";
  let bob = "";

  /** PostgreSQL's plan for a statement, which is not run. */
  async function planOf(text: string, values: unknown[]): Promise<PlanNode[]> {
    const { rows } = await pool.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      `explain (format json) ${text}`,
      values,
    );
    const plan = rows[0]?.["QUERY PLAN"][0].Plan;
    if (!plan) throw new Error("PostgreSQL gave no plan");
    return nodesOf(plan);
  }

  /** The plan of the statement `read` sends about the trail. */
  async function planOfRead(read: () => Promise<unknown>): Promise<PlanNode[]> {
    const sent = vi.spyOn(pg.Client.prototype, "query");
    try {
      await read();
      const call = sent.mock.calls
        .map((args: unknown[]) => args)
        .find(
          ([text]) => typeof text === "string" && /audit_events/.test(text),
        );
      if (!call) throw new Error("No statement read the trail");
      const [text, values] = call;
      return await planOf(String(text), Array.isArray(values) ? values : []);
    } finally {
      sent.mockRestore();
    }
  }

  /** How the plan reaches the trail: the indexes it walks, and its sorts. */
  function trailAccess(nodes: PlanNode[]) {
    return {
      indexes: nodes
        .filter((node) => node["Relation Name"] === "audit_events")
        .map((node) => node["Index Name"] ?? node["Node Type"]),
      sorts: nodes.filter((node) => /Sort/.test(node["Node Type"])).length,
    };
  }

  beforeAll(async () => {
    const created = await createTestDatabase("admin_trail");
    db = created.db;
    pool = created.pool;
    close = created.close;
    const account = async (name: string) =>
      (
        await db
          .insertInto("users")
          .values({
            email: `${name}-${suffix}@example.org`,
            displayName: name,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    ada = await account("ada");
    bob = await account("bob");
    const baseId = (await insertBase(db, ada, { name: "Ventes" })).id;
    const tableId = (
      await insertTable(db, ada, {
        baseId,
        name: "Clients",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    // A trail long enough for PostgreSQL to prefer an index when it has
    // one: 5,000 events a minute apart, one in a hundred of them Bob's.
    await sql`
      insert into audit_events
        (user_id, action, table_id, old_value, new_value, source, occurred_at)
      select
        case when n % 100 = 0 then ${bob}::uuid else ${ada}::uuid end,
        'update', ${tableId}::uuid, '{}'::jsonb, '{}'::jsonb, 'web',
        now() - make_interval(mins => n)
      from generate_series(1, 5000) as n
    `.execute(db);
    await sql`analyze audit_events`.execute(db);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("reads the newest events from the index, already in order", async () => {
    const nodes = await planOfRead(() => instanceAudit(db, { limit: 50 }));
    expect(trailAccess(nodes)).toEqual({
      indexes: ["audit_events_recent_idx"],
      sorts: 0,
    });
  });

  it("reads one account's events from the index by account", async () => {
    const nodes = await planOfRead(() =>
      instanceAudit(db, { userId: bob, limit: 50 }),
    );
    expect(trailAccess(nodes)).toEqual({
      indexes: ["audit_events_user_recent_idx"],
      sorts: 0,
    });
  });

  it("finds the events an erasure rewrites without reading the others", async () => {
    const nodes = await planOf(
      "update audit_events set user_id = $1 where user_id = $2",
      [ada, bob],
    );
    expect(trailAccess(nodes).indexes).toEqual([
      "ModifyTable",
      "audit_events_user_recent_idx",
    ]);
  });

  it("still lists the events it listed, newest first", async () => {
    const { events } = await instanceAudit(db, { userId: bob, limit: 3 });
    expect(events).toHaveLength(3);
    const times = events.map((event) => new Date(event.occurredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
