import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { createApiToken } from "../auth/tokens.js";
import { setAutomationEnabled } from "../automations.js";
import { createTestDatabase } from "../test-database.js";
import { updateWebhook } from "../webhooks.js";
import { withAudit } from "./audit-context.js";
import { renewCalendarFeed } from "./calendar-feeds.js";
import { loadEngine } from "./engine.js";
import {
  listBaseOverview,
  listBaseTables,
  listInstanceHooks,
  listInstanceTokens,
  listOutbound,
  revokeOutbound,
} from "./outbound.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { createShare } from "./sharing.js";
import { trashTable } from "./trash.js";
import { createView, trashView } from "./views.js";

const suffix = randomBytes(6).toString("hex");

describe("every public link and calendar feed, for an administrator", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let admin = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("outbound");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.org`, displayName: "Owner" },
        {
          email: `admin-${suffix}@example.org`,
          displayName: "Admin",
          isAdmin: true,
        },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    admin = people[1]?.id ?? "";
    const baseId = (await insertBase(db, owner, { name: "Ventes" })).id;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Clients",
        columns: [
          { name: "name", label: "Nom", fieldType: "text" },
          { name: "due", label: "Échéance", fieldType: "date" },
        ],
      })
    ).id;
  });

  afterAll(async () => {
    await close?.();
  });

  async function view(name: string) {
    const { engine } = await loadEngine(db, tableId, () => true);
    return createView(db, engine, {
      tableId,
      name,
      viewType: "calendar",
      ownerId: null,
    });
  }

  it("lists what each one opens and who made it, never its token or password", async () => {
    const shared = await view("Partagée");
    const share = await createShare(db, {
      viewId: shared.id,
      createdBy: owner,
      password: "a long enough password",
      allowCopy: false,
    });
    const token = await renewCalendarFeed(db, owner, shared.id);
    const listed = await listOutbound(db, 100);
    expect(listed.map((item) => [item.kind, item.view, item.author])).toEqual(
      expect.arrayContaining([
        ["link", "Partagée", "Owner"],
        ["feed", "Partagée", "Owner"],
      ]),
    );
    expect(listed.find((item) => item.kind === "link")).toMatchObject({
      id: share.id,
      base: "Ventes",
      table: "Clients",
      protected: true,
      expiresAt: null,
      expired: false,
    });
    const text = JSON.stringify(listed);
    expect(text).not.toContain(share.token);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/argon2|passwordHash|tokenHash/i);
  });

  it("revokes a link and removes a feed, the feed on the trail", async () => {
    const before = await listOutbound(db, 100);
    for (const item of before) {
      await revokeOutbound(db, admin, { kind: item.kind, id: item.id });
    }
    expect(await listOutbound(db, 100)).toEqual([]);
    const trail = await db
      .selectFrom("auditEvents")
      .select(["userId", "action"])
      .where("tableId", "=", tableId)
      .where("action", "=", "catalog")
      .where("userId", "=", admin)
      .execute();
    expect(trail).toHaveLength(1);
    // Revoked already: nothing left to revoke.
    const link = before.find((item) => item.kind === "link");
    await expect(
      revokeOutbound(db, admin, { kind: "link", id: link?.id ?? "" }),
    ).rejects.toMatchObject({ code: "no_row" });
  });

  it("leaves out the links of a view in the trash", async () => {
    const gone = await view("Jetée");
    await createShare(db, {
      viewId: gone.id,
      createdBy: owner,
      allowCopy: false,
    });
    expect((await listOutbound(db, 100)).map((item) => item.view)).toEqual([
      "Jetée",
    ]);
    await trashView(
      db,
      owner,
      await db
        .selectFrom("views")
        .selectAll()
        .where("id", "=", gone.id)
        .executeTakeFirstOrThrow(),
    );
    expect(await listOutbound(db, 100)).toEqual([]);
  });

  it("lists every token, webhook, and automation, a webhook by its host only", async () => {
    const { token } = await createApiToken(db, owner, "Reporting", {
      readOnly: true,
    });
    await db
      .insertInto("webhooks")
      .values({
        tableId,
        createdBy: owner,
        kind: "http",
        name: "Billing",
        target: "https://hooks.example.com/in/secret-path?key=hidden",
        events: ["row.created"],
        secretCiphertext: Buffer.alloc(16),
        secretNonce: Buffer.alloc(12),
      })
      .execute();
    const automation = await db
      .insertInto("automations")
      .values({
        tableId,
        createdBy: owner,
        name: "Reminder",
        trigger: { type: "row_created" },
        actions: [],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("automationRuns")
      .values({
        automationId: automation.id,
        status: "failed",
        trigger: "row_created",
      })
      .execute();

    const tokens = await listInstanceTokens(db, 100);
    expect(tokens).toMatchObject([
      { name: "Reporting", owner: "Owner", readOnly: true, bases: null },
    ]);
    const hooks = await listInstanceHooks(db, 100);
    expect(
      hooks.map((hook) => [hook.kind, hook.name, hook.on, hook.failures]),
    ).toEqual(
      expect.arrayContaining([
        ["webhook", "Billing", true, 0],
        ["automation", "Reminder", true, 1],
      ]),
    );
    expect(hooks.find((hook) => hook.kind === "webhook")?.host).toBe(
      "hooks.example.com",
    );
    const text = JSON.stringify({ tokens, hooks });
    expect(text).not.toContain(token);
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("hidden");

    // Switched off from there, they stay, off.
    const webhook = hooks.find((hook) => hook.kind === "webhook");
    await updateWebhook(db, keyRing(Buffer.alloc(32)), webhook?.id ?? "", {
      active: false,
    });
    await setAutomationEnabled(db, automation.id, false);
    expect((await listInstanceHooks(db, 100)).map((hook) => hook.on)).toEqual([
      false,
      false,
    ]);
  });

  it("weighs every base by the database's estimates, and lists its tables", async () => {
    const physical = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", tableId)
      .executeTakeFirstOrThrow();
    await withAudit(db, { userId: owner, tableId, source: "web" }, (tx) =>
      sql`insert into ${sql.table(physical.physicalName)} (name) values ('a'), ('b'), ('c')`.execute(
        tx,
      ),
    );
    await sql`analyze ${sql.table(physical.physicalName)}`.execute(db);
    const shared = await view("Ouverte");
    await createShare(db, {
      viewId: shared.id,
      createdBy: owner,
      allowCopy: false,
    });
    const [base] = await listBaseOverview(db, { limit: 10 });
    expect(base).toMatchObject({
      name: "Ventes",
      owners: ["Owner"],
      members: 1,
      tables: 1,
      estimatedRows: 3,
      fileBytes: 0,
      outbound: 1,
    });
    expect(
      await listBaseOverview(db, { limit: 10, search: "nothing" }),
    ).toEqual([]);
    expect(await listBaseTables(db, base?.id ?? "")).toEqual([
      {
        id: tableId,
        name: "Clients",
        external: false,
        estimatedRows: 3,
        fileBytes: 0,
      },
    ]);
    expect(
      (await listOutbound(db, 10, base?.id ?? "")).map((item) => item.view),
    ).toEqual(["Ouverte"]);
  });

  it("keeps each base's weights to itself, and names three owners at most", async () => {
    const [ventes] = await listBaseOverview(db, { limit: 10 });
    const people = await db
      .insertInto("users")
      .values(
        ["Ada", "Bob", "Cléo", "Dan", "Eve", "Zoé"].map((displayName) => ({
          email: `${displayName.toLowerCase()}-${suffix}@example.org`,
          displayName,
        })),
      )
      .returning("id")
      .execute();
    const [ada, bob, cleo, dan, eve, zoe] = people.map((person) => person.id);
    const achats = (await insertBase(db, ada ?? "", { name: "Achats" })).id;
    await insertBase(db, zoe ?? "", { name: "Vide" });
    await withAudit(db, { userId: ada ?? "", source: "web" }, async (tx) => {
      const group = await tx
        .insertInto("groups")
        .values({ displayName: "Acheteurs" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("roleBindings")
        .values([
          ...[dan, cleo, bob].map((userId) => ({
            userId: userId ?? "",
            role: "owner" as const,
            scope: "base" as const,
            scopeId: achats,
          })),
          // An owner through a group counts as a member, not by name.
          {
            userId: eve ?? "",
            role: "owner" as const,
            scope: "base" as const,
            scopeId: achats,
            groupId: group.id,
          },
        ])
        .execute();
    });
    const columns = [
      { name: "name", label: "Nom", fieldType: "text" as const },
    ];
    const kept = await insertTable(db, ada ?? "", {
      baseId: achats,
      name: "Commandes",
      columns,
    });
    const gone = await insertTable(db, ada ?? "", {
      baseId: achats,
      name: "Brouillon",
      columns,
    });
    await trashTable(
      db,
      ada ?? "",
      await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", gone.id)
        .executeTakeFirstOrThrow(),
    );
    await db
      .insertInto("attachments")
      .values({
        key: `files/${suffix}`,
        tableId: kept.id,
        filename: "devis.pdf",
        mime: "application/pdf",
        size: "1234",
      })
      .execute();

    const bases = await listBaseOverview(db, { limit: 10 });
    expect(bases.map((base) => base.name)).toEqual([
      "Achats",
      "Ventes",
      "Vide",
    ]);
    expect(bases[0]).toMatchObject({
      owners: ["Ada", "Bob", "Cléo"],
      hasLiveOwner: true,
      members: 5,
      tables: 1,
      estimatedRows: 0,
      fileBytes: 1234,
      outbound: 0,
    });
    // What another base holds changed nothing of this one.
    expect(bases[1]).toEqual(ventes);
    expect(bases[2]).toMatchObject({
      owners: ["Zoé"],
      members: 1,
      tables: 0,
      estimatedRows: 0,
      fileBytes: 0,
      outbound: 0,
    });
    expect(await listBaseOverview(db, { limit: 2 })).toEqual(bases.slice(0, 2));
  });
});
