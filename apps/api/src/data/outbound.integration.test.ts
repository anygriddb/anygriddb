import { giveInstanceRole } from "../auth/instance-roles.test-helpers.js";
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { createAdminToken } from "../auth/admin-tokens.js";
import { createApiToken } from "../auth/tokens.js";
import { createScimToken } from "../scim/tokens.js";
import { setAutomationEnabled } from "../automations.js";
import { createTestDatabase } from "../test-database.js";
import { updateWebhook } from "../webhooks.js";
import { withAudit } from "./audit-context.js";
import { renewCalendarFeed } from "./calendar-feeds.js";
import { loadEngine } from "./engine.js";
import { listAccesses, revokeAccess } from "./accesses.js";
import {
  listBaseOverview,
  listBaseTables,
  listInstanceHooks,
} from "./outbound.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { createShare } from "./sharing.js";
import { trashTable } from "./trash.js";
import { createView, trashView } from "./views.js";

const suffix = randomBytes(6).toString("hex");

describe("everything that reaches the instance without a session, for an administrator", () => {
  let db: Database;
  let ownerDb: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let admin = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("outbound");
    db = created.db;
    ownerDb = created.owner.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.org`, displayName: "Owner" },
        {
          email: `admin-${suffix}@example.org`,
          displayName: "Admin",
        },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    admin = people[1]?.id ?? "";
    await giveInstanceRole(db, admin);
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
    return createView(db, engine, owner, {
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
    const listed = await listAccesses(db, { limit: 100 });
    expect(
      listed.accesses.map((item) => [item.kind, item.view, item.author]),
    ).toEqual(
      expect.arrayContaining([
        ["link", "Partagée", "Owner"],
        ["feed", "Partagée", "Owner"],
      ]),
    );
    expect(listed.accesses.find((item) => item.kind === "link")).toMatchObject({
      id: share.id,
      base: "Ventes",
      table: "Clients",
      protected: true,
      state: "live",
    });
    const text = JSON.stringify(listed);
    expect(text).not.toContain(share.token);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/argon2|passwordHash|secretHash|tokenHash/i);
  });

  it("revokes a link and a feed, both on the trail, and keeps them revoked", async () => {
    const before = (await listAccesses(db, { limit: 100 })).accesses;
    for (const item of before) {
      await revokeAccess(db, admin, item.id);
    }
    expect(await listAccesses(db, { limit: 100 })).toEqual({
      accesses: [],
      total: 0,
    });
    expect(
      (await listAccesses(db, { limit: 100, revoked: true })).accesses.map(
        (item) => item.state,
      ),
    ).toEqual(["revoked", "revoked"]);
    const trail = await db
      .selectFrom("auditEvents")
      .select(["userId", "action"])
      .where("tableId", "=", tableId)
      .where("action", "=", "catalog")
      .where("userId", "=", admin)
      .execute();
    // One event per revoke: the link and the feed.
    expect(trail.length).toBeGreaterThanOrEqual(2);
    // Revoked already: nothing left to revoke.
    const link = before.find((item) => item.kind === "link");
    await expect(revokeAccess(db, admin, link?.id ?? "")).rejects.toMatchObject(
      { code: "no_row" },
    );
  });

  it("says a link of a view in the trash acts on nothing", async () => {
    const gone = await view("Jetée");
    await createShare(db, {
      viewId: gone.id,
      createdBy: owner,
      allowCopy: false,
    });
    expect(
      (await listAccesses(db, { limit: 100 })).accesses.map((item) => [
        item.view,
        item.state,
      ]),
    ).toEqual([["Jetée", "live"]]);
    await trashView(
      db,
      owner,
      await db
        .selectFrom("views")
        .selectAll()
        .where("id", "=", gone.id)
        .executeTakeFirstOrThrow(),
    );
    expect(
      (await listAccesses(db, { limit: 100 })).accesses.map((item) => [
        item.view,
        item.state,
      ]),
    ).toEqual([["Jetée", "suspended"]]);
  });

  it("lists every token, webhook, and automation, a webhook by its host only", async () => {
    const { token } = await createApiToken(db, owner, "Reporting", {
      readOnly: true,
    });
    await withAudit(
      db,
      { userId: owner, tableId, source: "web" },
      async (tx) => {
        await tx
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
      },
    );
    const automation = await withAudit(
      db,
      { userId: owner, tableId, source: "web" },
      (tx) =>
        tx
          .insertInto("automations")
          .values({
            tableId,
            createdBy: owner,
            name: "Reminder",
            trigger: { type: "row_created" },
            actions: [],
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
    );
    await db
      .insertInto("automationRuns")
      .values({
        automationId: automation.id,
        status: "failed",
        trigger: "row_created",
      })
      .execute();

    const tokens = (await listAccesses(db, { limit: 100 })).accesses.filter(
      (item) => item.kind === "api_token",
    );
    expect(tokens).toMatchObject([
      {
        name: "Reporting",
        author: "Owner",
        readOnly: true,
        bases: null,
        state: "live",
      },
    ]);
    const hooks = await listInstanceHooks(db, {
      webhooks: { limit: 100 },
      automations: { limit: 100 },
    });
    const allHooks = [...hooks.webhooks, ...hooks.automations];
    expect(
      allHooks.map((hook) => [hook.kind, hook.name, hook.on, hook.failures]),
    ).toEqual(
      expect.arrayContaining([
        ["webhook", "Billing", true, 0],
        ["automation", "Reminder", true, 1],
      ]),
    );
    expect(hooks.webhooks[0]?.host).toBe("hooks.example.com");
    const text = JSON.stringify({ tokens, hooks });
    expect(text).not.toContain(token);
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("hidden");

    // Switched off from there, they stay, off.
    const webhook = hooks.webhooks[0];
    await updateWebhook(
      db,
      keyRing(Buffer.alloc(32)),
      owner,
      webhook?.id ?? "",
      { active: false },
    );
    await setAutomationEnabled(db, owner, automation.id, false);
    const after = await listInstanceHooks(db, {
      webhooks: { limit: 100 },
      automations: { limit: 100 },
    });
    expect(
      [...after.webhooks, ...after.automations].map((hook) => hook.on),
    ).toEqual([false, false]);
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
    await sql`analyze ${sql.table(physical.physicalName)}`.execute(ownerDb);
    const shared = await view("Ouverte");
    await createShare(db, {
      viewId: shared.id,
      createdBy: owner,
      allowCopy: false,
    });
    const base = (await listBaseOverview(db, { limit: 10 })).bases[0];
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
    ).toEqual({ bases: [], total: 0 });
    expect(await listBaseTables(db, base?.id ?? "")).toEqual([
      {
        id: tableId,
        name: "Clients",
        external: false,
        estimatedRows: 3,
        fileBytes: 0,
        lastActivityAt: base?.lastActivityAt,
      },
    ]);
    // Its one table's newest event is the base's own.
    expect(base?.lastActivityAt).toEqual(expect.any(String));
    // A base's accesses: its live link, and the one of a view in the trash.
    expect(
      (
        await listAccesses(db, { limit: 10, baseId: base?.id ?? "" })
      ).accesses.map((item) => [item.view, item.state]),
    ).toEqual([
      ["Ouverte", "live"],
      ["Jetée", "suspended"],
    ]);
  });

  it("keeps each base's weights to itself, and names three owners at most", async () => {
    const ventes = (await listBaseOverview(db, { limit: 10 })).bases[0];
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
        .insertInto("attributions")
        .values([
          ...[dan, cleo, bob].map((userId) => ({
            userId: userId ?? "",
            role: "owner" as const,
            scope: "base" as const,
            scopeId: achats,
          })),
          // An owner through a group counts as a member, not by name.
          {
            role: "owner" as const,
            scope: "base" as const,
            scopeId: achats,
            groupId: group.id,
          },
        ])
        .execute();
      await tx
        .insertInto("groupMembers")
        .values({ groupId: group.id, userId: eve ?? "" })
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

    const listed = await listBaseOverview(db, { limit: 10 });
    const bases = listed.bases;
    expect(bases.map((base) => base.name)).toEqual([
      "Achats",
      "Ventes",
      "Vide",
    ]);
    expect(listed.total).toBe(3);
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
    expect(await listBaseOverview(db, { limit: 2 })).toEqual({
      bases: bases.slice(0, 2),
      total: 3,
    });
    // A base with no table was never used: the trails name tables.
    expect(bases[2]?.lastActivityAt).toBeNull();
  });

  it("says when a base and each of its tables were last used, by what the three trails hold", async () => {
    const maker = (
      await db
        .insertInto("users")
        .values({
          email: `maker-${suffix}@example.org`,
          displayName: "Maker",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const baseId = (await insertBase(db, maker, { name: "Atelier" })).id;
    const columns = [
      { name: "name", label: "Nom", fieldType: "text" as const },
    ];
    const made = (name: string) =>
      insertTable(db, maker, { baseId, name, columns });
    const parts = (await made("Pièces")).id;
    const tools = (await made("Outils")).id;
    const scrap = await made("Rebut");
    // Every instant is ahead of the clock, so that what made the tables,
    // written a moment ago, is older than each of them.
    const start = Date.now();
    const hours = (count: number) => new Date(start + count * 3_600_000);
    const used = async () => {
      const [base] = (await listBaseOverview(db, { baseId, limit: 1 })).bases;
      const tables = await listBaseTables(db, baseId);
      return {
        base: base?.lastActivityAt,
        tables: Object.fromEntries(
          tables.map((table) => [table.name, table.lastActivityAt]),
        ),
      };
    };

    // Making its tables is the first use of a base.
    const atFirst = await used();
    expect(Object.keys(atFirst.tables)).toEqual(["Pièces", "Outils", "Rebut"]);
    expect(Date.parse(atFirst.base ?? "")).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(atFirst.base ?? "")).toBeGreaterThan(start - 60_000);

    // A row changed, on the change trail.
    await db
      .insertInto("auditEvents")
      .values({
        userId: maker,
        action: "update",
        tableId: parts,
        oldValue: { name: "a" },
        newValue: { name: "b" },
        source: "web",
        occurredAt: hours(1),
      })
      .execute();
    expect(await used()).toMatchObject({
      base: hours(1).toISOString(),
      tables: { Pièces: hours(1).toISOString() },
    });

    // A row written in a client's database, on the trail of those writes.
    await db
      .insertInto("externalWrites")
      .values({
        userId: maker,
        tableId: tools,
        sourceId: "33333333-3333-4333-8333-333333333333",
        rowId: "1",
        action: "update",
        oldValue: {},
        newValue: {},
        requestedAt: hours(2),
      })
      .execute();
    expect(await used()).toMatchObject({
      base: hours(2).toISOString(),
      tables: {
        Pièces: hours(1).toISOString(),
        Outils: hours(2).toISOString(),
      },
    });

    // A status a person gave a client's row; what a check found later on
    // that row is nobody's use of the table.
    await db
      .insertInto("externalStatusEvents")
      .values([
        {
          userId: maker,
          tableId: parts,
          rowId: "1",
          action: "lock",
          source: "web",
          at: hours(3),
        },
        {
          userId: null,
          tableId: parts,
          rowId: "1",
          action: "changed",
          source: "check",
          at: hours(4),
        },
      ])
      .execute();
    expect(await used()).toMatchObject({
      base: hours(3).toISOString(),
      tables: {
        Pièces: hours(3).toISOString(),
        Outils: hours(2).toISOString(),
      },
    });

    // A table in the trash is not listed, and its events are not the
    // base's: the date is the newest of the tables the page shows.
    await trashTable(
      db,
      maker,
      await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", scrap.id)
        .executeTakeFirstOrThrow(),
    );
    await db
      .insertInto("auditEvents")
      .values({
        userId: maker,
        action: "export",
        tableId: scrap.id,
        source: "web",
        occurredAt: hours(5),
      })
      .execute();
    expect(await used()).toEqual({
      base: hours(3).toISOString(),
      tables: {
        Pièces: hours(3).toISOString(),
        Outils: hours(2).toISOString(),
      },
    });
  });

  it("says which accesses act on nothing while their author may not, and revokes any kind", async () => {
    const author = (
      await db
        .insertInto("users")
        .values({
          email: `author-${suffix}@example.org`,
          displayName: "Author",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const keeper = (
      await db
        .insertInto("users")
        .values({
          email: `keeper-${suffix}@example.org`,
          displayName: "Keeper",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await giveInstanceRole(db, keeper);
    const script = await createApiToken(db, author, "Nightly");
    const ci = await createAdminToken(db, keeper, {
      name: "CI",
      scopes: ["settings"],
    });
    const scim = await createScimToken(db, keeper, "Directory");
    const stateOf = async (id: string) =>
      (await listAccesses(db, { limit: 100, revoked: true })).accesses.find(
        (item) => item.id === id,
      )?.state;
    expect([
      await stateOf(script.id),
      await stateOf(ci.id),
      await stateOf(scim.id),
    ]).toEqual(["live", "live", "live"]);
    // An administration token's scopes are no base's permissions.
    expect(
      (await listAccesses(db, { limit: 100 })).accesses.find(
        (item) => item.id === ci.id,
      )?.readOnly,
    ).toBe(false);

    // An author disabled: their token waits; an administrator no longer
    // one: theirs wait. Each comes back with what it waited on.
    await db
      .updateTable("users")
      .set({ disabledAt: new Date(), disabledReason: "admin" })
      .where("id", "=", author)
      .execute();
    await giveInstanceRole(db, keeper, "administrator", false);
    expect([
      await stateOf(script.id),
      await stateOf(ci.id),
      await stateOf(scim.id),
    ]).toEqual(["suspended", "suspended", "suspended"]);
    await db
      .updateTable("users")
      .set({ disabledAt: null, disabledReason: null })
      .where("id", "=", author)
      .execute();
    await giveInstanceRole(db, keeper);
    expect([
      await stateOf(script.id),
      await stateOf(ci.id),
      await stateOf(scim.id),
    ]).toEqual(["live", "live", "live"]);

    // Revoked from the one page, each as its own page revokes it.
    for (const id of [script.id, ci.id, scim.id]) {
      await revokeAccess(db, admin, id);
    }
    expect([
      await stateOf(script.id),
      await stateOf(ci.id),
      await stateOf(scim.id),
    ]).toEqual(["revoked", "revoked", "revoked"]);
    const signIns = await db
      .selectFrom("authEvents")
      .select(["action", "actorId", "method"])
      .where("userId", "=", author)
      .where("action", "=", "tokens_revoked")
      .execute();
    expect(signIns).toEqual([
      { action: "tokens_revoked", actorId: admin, method: "admin" },
    ]);
  });
});
