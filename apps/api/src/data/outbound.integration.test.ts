import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { setAutomationEnabled } from "../automations.js";
import { createTestDatabase } from "../test-database.js";
import { updateWebhook } from "../webhooks.js";
import { renewCalendarFeed } from "./calendar-feeds.js";
import { loadEngine } from "./engine.js";
import {
  listInstanceHooks,
  listInstanceTokens,
  listOutbound,
  revokeOutbound,
} from "./outbound.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { createShare } from "./sharing.js";
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
    await updateWebhook(db, Buffer.alloc(32), webhook?.id ?? "", {
      active: false,
    });
    await setAutomationEnabled(db, automation.id, false);
    expect((await listInstanceHooks(db, 100)).map((hook) => hook.on)).toEqual([
      false,
      false,
    ]);
  });
});
