/**
 * What gives access to a base or sends its data out leaves an event on
 * the change trail, under its author's name, which says what it changed,
 * and holds no secret and no address of a person.
 */
import { giveInstanceRole } from "../auth/instance-roles.test-helpers.js";
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken, revokeApiToken } from "../auth/tokens.js";
import { saveAutomation, setAutomationEnabled } from "../automations.js";
import { addLocalGroupMember, createLocalGroup } from "../scim/groups.js";
import { createTestDatabase } from "../test-database.js";
import { deleteWebhook } from "../webhooks.js";
import { sql } from "kysely";
import { withAudit } from "./audit-context.js";
import { endEmergencyAccess } from "./emergency-access.js";
import { insertBase, insertTable } from "./schema-ops.js";
import {
  createBaseShare,
  createInvitation,
  createShare,
  revokeInvitation,
  revokeShare,
} from "./sharing.js";

const suffix = randomBytes(6).toString("hex");

function secretsIn(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /token_hash|password_hash|secret_ciphertext|secret_nonce|headers_ciphertext|headers_nonce|webhook_token_hash|ag_[A-Za-z0-9_-]{20,}/i.test(
    text,
  );
}

describe("access given and data sent out, on the change trail", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let admin = "";
  let member = "";
  let baseId = "";
  let tableId = "";
  let viewId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("audit_egress");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.org`, displayName: "Owner" },
        {
          email: `admin-${suffix}@example.org`,
          displayName: "Admin",
        },
        { email: `member-${suffix}@example.org`, displayName: "Member" },
      ])
      .returning("id")
      .execute();
    await giveInstanceRole(db, people[1]?.id ?? "");
    owner = people[0]?.id ?? "";
    admin = people[1]?.id ?? "";
    member = people[2]?.id ?? "";
    baseId = (await insertBase(db, owner, { name: "Trail" })).id;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Rows",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    viewId = (
      await db
        .selectFrom("views")
        .select("id")
        .where("tableId", "=", tableId)
        .executeTakeFirstOrThrow()
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("records a public link create and revoke without the token or password", async () => {
    const share = await createShare(db, {
      viewId,
      createdBy: owner,
      password: "a long enough password",
      allowCopy: false,
    });
    await revokeShare(db, owner, share.id);
    const events = await db
      .selectFrom("auditEvents")
      .select(["userId", "oldValue", "newValue"])
      .where("tableId", "=", tableId)
      .where("action", "=", "catalog")
      .where("userId", "=", owner)
      .orderBy("occurredAt", "desc")
      .limit(10)
      .execute();
    const aboutShare = events.filter(
      (event) =>
        JSON.stringify(event.newValue ?? event.oldValue).includes(share.id) ||
        JSON.stringify(event.oldValue ?? {}).includes('"revoked_at"') ||
        JSON.stringify(event.newValue ?? {}).includes('"view_id"'),
    );
    expect(aboutShare.length).toBeGreaterThanOrEqual(2);
    expect(aboutShare.every((event) => event.userId === owner)).toBe(true);
    for (const event of aboutShare) {
      expect(secretsIn(event.oldValue)).toBe(false);
      expect(secretsIn(event.newValue)).toBe(false);
      expect(JSON.stringify(event)).not.toContain(share.token);
    }
  });

  it("records a whole-base link create and revoke without the token", async () => {
    const share = await createBaseShare(db, {
      baseId,
      createdBy: owner,
      password: "a long enough password",
    });
    await revokeShare(db, owner, share.id);
    const events = await db
      .selectFrom("auditEvents")
      .select(["userId", "oldValue", "newValue", "tableId"])
      .where("action", "=", "catalog")
      .where("userId", "=", owner)
      .orderBy("occurredAt", "desc")
      .limit(20)
      .execute();
    const aboutShare = events.filter((event) =>
      JSON.stringify(event.newValue ?? event.oldValue).includes(share.id),
    );
    expect(aboutShare.length).toBeGreaterThanOrEqual(2);
    expect(aboutShare.every((event) => event.tableId === null)).toBe(true);
    for (const event of aboutShare) {
      expect(secretsIn(event.oldValue)).toBe(false);
      expect(secretsIn(event.newValue)).toBe(false);
      expect(JSON.stringify(event)).not.toContain(share.token);
    }
  });

  it("records an invitation made and withdrawn, without its link or the address invited", async () => {
    const address = `guest-${suffix}@example.org`;
    const invite = await createInvitation(db, {
      baseId,
      email: address,
      role: "editor",
      invitedBy: owner,
    });
    const pending = await db
      .selectFrom("invitations")
      .select("id")
      .where("baseId", "=", baseId)
      .where("email", "=", address)
      .executeTakeFirstOrThrow();
    await revokeInvitation(db, owner, baseId, pending.id);
    const events = await db
      .selectFrom("auditEvents")
      .select(["userId", "oldValue", "newValue"])
      .where("action", "=", "catalog")
      .where("catalogTable", "=", "invitations")
      .orderBy("occurredAt")
      .execute();
    // Made, then withdrawn: by the owner, on this base, as an editor.
    expect(events.map((event) => event.userId)).toEqual([owner, owner]);
    expect(events[0]?.oldValue).toBeNull();
    expect(events[0]?.newValue).toMatchObject({
      base_id: baseId,
      role: "editor",
    });
    expect(events[1]?.newValue).toBeNull();
    for (const event of events) {
      const text = JSON.stringify(event);
      expect(secretsIn(event.oldValue)).toBe(false);
      expect(secretsIn(event.newValue)).toBe(false);
      expect(text).not.toContain(invite.token);
      // The trail outlives an account's erasure: it names no address.
      expect(text).not.toContain(address);
      expect(text).not.toContain('"email"');
    }
  });

  it("says which table each event changed, and where the write came from", async () => {
    const tables = await db
      .selectFrom("auditEvents")
      .select(["catalogTable", "source"])
      .distinct()
      .where("action", "=", "catalog")
      .where("userId", "=", owner)
      .execute();
    expect(tables.map((row) => row.catalogTable)).toEqual(
      expect.arrayContaining(["shares", "invitations", "data_tables"]),
    );
    expect(tables.some((row) => row.catalogTable === null)).toBe(false);
    expect(
      tables
        .filter((row) => row.catalogTable === "shares")
        .map((row) => row.source),
    ).toEqual(["web"]);
  });

  it("records webhook and automation changes without sealed secrets", async () => {
    const hook = await withAudit(
      db,
      { userId: owner, tableId, source: "web" },
      (tx) =>
        tx
          .insertInto("webhooks")
          .values({
            tableId,
            createdBy: owner,
            kind: "http",
            name: "Billing",
            target: "https://hooks.example.com/path?secret=hidden",
            events: ["row.created"],
            secretCiphertext: Buffer.alloc(16),
            secretNonce: Buffer.alloc(12),
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
    );
    await deleteWebhook(db, owner, hook.id);
    const automation = await saveAutomation(db, {
      tableId,
      createdBy: owner,
      name: "Ping",
      enabled: true,
      trigger: { type: "webhook" },
      actions: [{ type: "notify", users: [owner], message: "hi" }],
    });
    await setAutomationEnabled(db, owner, automation.id, false);
    const eventsOf = (table: string) =>
      db
        .selectFrom("auditEvents")
        .select(["oldValue", "newValue"])
        .where("tableId", "=", tableId)
        .where("action", "=", "catalog")
        .where("catalogTable", "=", table)
        .where("userId", "=", owner)
        .orderBy("occurredAt")
        .orderBy("id")
        .execute();
    const targetOf = (value: unknown) =>
      (value as { target?: string } | null)?.target;

    // Made, then deleted: where it sends, without what follows "?".
    const aboutHook = await eventsOf("webhooks");
    expect(aboutHook).toHaveLength(2);
    expect(targetOf(aboutHook[0]?.newValue)).toBe(
      "https://hooks.example.com/path",
    );
    expect(targetOf(aboutHook[1]?.oldValue)).toBe(
      "https://hooks.example.com/path",
    );
    for (const event of aboutHook) {
      expect(secretsIn(event.oldValue)).toBe(false);
      expect(secretsIn(event.newValue)).toBe(false);
      expect(JSON.stringify(event)).not.toContain("hidden");
    }
    // Made, then switched off.
    const aboutAutomation = await eventsOf("automations");
    expect(aboutAutomation).toHaveLength(2);
    expect(aboutAutomation[1]?.newValue).toMatchObject({
      name: "Ping",
      enabled: false,
    });
    for (const event of aboutAutomation) {
      expect(secretsIn(event.oldValue)).toBe(false);
      expect(secretsIn(event.newValue)).toBe(false);
      if (automation.webhookToken) {
        expect(JSON.stringify(event)).not.toContain(automation.webhookToken);
      }
    }
  });

  it("records API token create and revoke on the sign-in trail without the token", async () => {
    const made = await createApiToken(db, owner, "script");
    await revokeApiToken(db, owner, made.id);
    const events = await db
      .selectFrom("authEvents")
      .select(["action", "userId", "detail"])
      .where("userId", "=", owner)
      .where("action", "in", ["token_created", "tokens_revoked"])
      .orderBy("occurredAt", "desc")
      .limit(5)
      .execute();
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["token_created", "tokens_revoked"]),
    );
    expect(events.every((event) => event.detail === "self_service_token")).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toContain(made.token);
  });

  it("records group membership and ending emergency access", async () => {
    const group = await createLocalGroup(db, admin, {
      displayName: `Team ${suffix}`,
      description: null,
    });
    await addLocalGroupMember(db, admin, {
      groupId: group.id,
      userId: member,
    });
    const memberEvents = await db
      .selectFrom("auditEvents")
      .select(["userId", "newValue", "oldValue"])
      .where("action", "=", "catalog")
      .where("userId", "=", admin)
      .orderBy("occurredAt", "desc")
      .limit(20)
      .execute();
    const membership = memberEvents.filter((event) =>
      JSON.stringify(event.newValue ?? event.oldValue).includes(member),
    );
    expect(membership.length).toBeGreaterThanOrEqual(1);

    await db
      .insertInto("emergencyAccess")
      .values({
        baseId,
        userId: admin,
        reason: "Check the books.",
        expiresAt: sql<Date>`now() + interval '1 hour'`,
      })
      .execute();
    expect(await endEmergencyAccess(db, { userId: admin, baseId })).toBe(true);
    const closed = await db
      .selectFrom("auditEvents")
      .select(["newValue", "userId"])
      .where("action", "=", "access")
      .where("userId", "=", admin)
      .orderBy("occurredAt", "desc")
      .limit(5)
      .execute();
    expect(
      closed.some(
        (event) =>
          event.newValue !== null &&
          typeof event.newValue === "object" &&
          "endedAt" in event.newValue,
      ),
    ).toBe(true);
  });
});
