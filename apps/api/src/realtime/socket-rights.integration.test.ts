/**
 * What an open socket hears, against the rights its account holds now: every
 * way a right is taken away, with the socket on another process than the
 * one that took it.
 */
import { errorCode } from "../trpc/caller.test-helpers.js";
import { giveTableByTable } from "../data/rules.test-helpers.js";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizeGrid, gridChannelRights } from "../auth/access.js";
import { keyRing } from "../auth/key-ring.js";
import { sessionIdentities } from "../auth/session.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import type { Env } from "../env.js";
import { registerScim } from "../scim/routes.js";
import { setGroupRole } from "../scim/groups.js";
import { createScimToken } from "../scim/tokens.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  joinBase,
  signUpProved,
  type TestBrowser,
} from "../trpc/caller.test-helpers.js";
import { GridHub } from "../ws.js";
import { PgBus } from "./bus.js";
import { publishRows } from "./channels.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const SCIM = "application/scim+json";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ROW = "00000000-0000-4000-8000-00000000e001";

type Person = { id: string; email: string; page: TestBrowser };

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const closed: number[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string) => {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    ping: () => undefined,
    close: (code: number) => {
      closed.push(code);
      socket.readyState = 3;
    },
    terminate: () => {
      closed.push(1006);
      socket.readyState = 3;
    },
  });
  return { socket, sent, closed };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("what an open socket hears", () => {
  let db: Database;
  let pool: pg.Pool;
  let url = "";
  let close: (() => Promise<void>) | undefined;
  let here: PgBus;
  let there: PgBus;
  let hubHere: GridHub;
  let hubThere: GridHub;
  let scim: FastifyInstance;
  let scimToken = "";
  let adminId = "";
  let baseId = "";
  let tableId = "";
  let witness: ReturnType<typeof fakeSocket>;
  let n = 0;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hubOfRequests = {
    closeUser: (userId: string) => hubHere.closeUser(userId),
    closeAllBut: (userId: string) => hubHere.closeAllBut(userId),
    closeSession: (hash: string, code?: 4000 | 4401) =>
      hubHere.closeSession(hash, code),
  };
  const browser = browserFactory({
    db: () => db,
    env,
    hub: hubOfRequests,
    bus: () => here,
  });
  const admin = browser();

  const hubOn = (bus: PgBus) =>
    new GridHub(
      bus,
      db,
      (userId, channel, action) => authorizeGrid(db, userId, channel, action),
      () => undefined,
      (hashes) => sessionIdentities(db, hashes),
      (wanted) => gridChannelRights(db, wanted),
    );

  const person = async (name: string): Promise<Person> => {
    n += 1;
    const email = `${name}-${String(n)}-${suffix}@example.org`;
    const page = browser();
    const id = await signUpProved(page, db, {
      email,
      displayName: name,
      password: PASSWORD,
    });
    return { id, email, page };
  };

  /** A socket of this account on the other process, following the table. */
  const following = async (userId: string, channel = tableId) => {
    const opened = fakeSocket();
    hubThere.add(opened.socket as never, userId, "Reader");
    opened.socket.emit(
      "message",
      JSON.stringify({ type: "subscribe", channel }),
    );
    await until(
      () => opened.sent.some((message) => message.type === "subscribed"),
      "subscribed",
    );
    return opened;
  };

  /** Publishes one change and waits for the witness to hear it. */
  const change = async (channel = tableId) => {
    const before = witness.sent.length;
    await publishRows(here, channel, "update", [ROW], () => undefined);
    await until(() => witness.sent.length > before, "the witness heard it");
  };

  const rowsHeard = (sent: ReadonlyArray<Record<string, unknown>>) =>
    sent.filter((message) => message.type === "rows").length;

  const scimCall = async (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: unknown,
  ) => {
    const response = await scim.inject({
      method,
      url: `/scim/v2${path}`,
      headers: {
        authorization: `Bearer ${scimToken}`,
        "content-type": SCIM,
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    expect(response.statusCode).toBeLessThan(300);
    return (response.body ? JSON.parse(response.body) : {}) as { id: string };
  };

  const localGroup = async (member: Person) => {
    const group = await admin.call().admin.groups.create({
      displayName: `Team ${randomBytes(4).toString("hex")}`,
    });
    await admin
      .call()
      .admin.groups.addMember({ groupId: group.id, userId: member.id });
    return group.id;
  };

  beforeAll(async () => {
    const created = await createTestDatabase("socket_rights");
    db = created.db;
    pool = created.pool;
    url = created.url;
    close = created.close;
    here = new PgBus(pool, url, () => undefined);
    there = new PgBus(pool, url, () => undefined);
    hubHere = hubOn(here);
    hubThere = hubOn(there);
    await here.start();
    await there.start();
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password: PASSWORD });
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `admin-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(db, adminId, { name: "Ventes" })).id;
    tableId = (
      await insertTable(db, adminId, {
        baseId,
        name: "Invoices",
        columns: [{ name: "title", fieldType: "text", label: "Title" }],
      })
    ).id;
    ({ token: scimToken } = await createScimToken(db, adminId, "IdP"));
    scim = Fastify();
    registerScim(scim, {
      db,
      publicUrl: "https://grid.example",
      bus: here,
    });
    await scim.ready();
    witness = await following(adminId);
  }, 120_000);

  afterAll(async () => {
    await scim.close();
    await here.close();
    await there.close();
    await close?.();
  });

  const paths: Array<{
    name: string;
    take: (member: Person) => Promise<void>;
    give: (member: Person) => Promise<void>;
  }> = (() => {
    let groupId = "";
    let scimGroupId = "";
    return [
      {
        name: "removed from the base",
        give: async (member) => {
          await joinBase(db, { baseId, userId: member.id, role: "viewer" });
        },
        take: async (member) => {
          await admin.call().catalog.revoke({ baseId, userId: member.id });
        },
      },
      {
        name: "base role taken in Administration",
        give: async (member) => {
          await admin
            .call()
            .admin.setBaseRole({ userId: member.id, baseId, role: "viewer" });
        },
        take: async (member) => {
          await admin
            .call()
            .admin.removeBaseRole({ userId: member.id, baseId });
        },
      },
      {
        name: "removed from a group in Administration",
        give: async (member) => {
          groupId = await localGroup(member);
          await admin
            .call()
            .admin.groups.setBaseRole({ groupId, baseId, role: "viewer" });
        },
        take: async (member) => {
          await admin
            .call()
            .admin.groups.removeMember({ groupId, userId: member.id });
        },
      },
      {
        name: "table role removed",
        give: async (member) => {
          await admin.call().catalog.setTableRole({
            tableId,
            userId: member.id,
            role: "viewer",
          });
        },
        take: async (member) => {
          await admin.call().catalog.setTableRole({
            tableId,
            userId: member.id,
            role: null,
          });
        },
      },
      {
        name: "group's role removed in Administration",
        give: async (member) => {
          groupId = await localGroup(member);
          await admin
            .call()
            .admin.groups.setBaseRole({ groupId, baseId, role: "viewer" });
        },
        take: async () => {
          await admin
            .call()
            .admin.groups.setBaseRole({ groupId, baseId, role: null });
        },
      },
      {
        name: "group's role removed by the base's owner",
        give: async (member) => {
          groupId = await localGroup(member);
          await admin
            .call()
            .catalog.setGroupRole({ baseId, groupId, role: "viewer" });
        },
        take: async () => {
          await admin
            .call()
            .catalog.setGroupRole({ baseId, groupId, role: null });
        },
      },
      {
        name: "group deleted",
        give: async (member) => {
          groupId = await localGroup(member);
          await admin
            .call()
            .admin.groups.setBaseRole({ groupId, baseId, role: "viewer" });
        },
        take: async () => {
          await admin.call().admin.groups.delete({ groupId });
        },
      },
      {
        name: "removed from a group by SCIM",
        give: async (member) => {
          scimGroupId = (
            await scimCall("POST", "/Groups", {
              schemas: [GROUP],
              displayName: `IdP ${randomBytes(4).toString("hex")}`,
              members: [{ value: member.id }],
            })
          ).id;
          await setGroupRole(db, adminId, {
            baseId,
            groupId: scimGroupId,
            role: "viewer",
          });
        },
        take: async (member) => {
          await scimCall("PATCH", `/Groups/${scimGroupId}`, {
            schemas: [PATCH],
            Operations: [
              { op: "remove", path: `members[value eq "${member.id}"]` },
            ],
          });
        },
      },
      {
        name: "group deleted by SCIM",
        give: async (member) => {
          scimGroupId = (
            await scimCall("POST", "/Groups", {
              schemas: [GROUP],
              displayName: `IdP ${randomBytes(4).toString("hex")}`,
              members: [{ value: member.id }],
            })
          ).id;
          await setGroupRole(db, adminId, {
            baseId,
            groupId: scimGroupId,
            role: "viewer",
          });
        },
        take: async () => {
          await scimCall("DELETE", `/Groups/${scimGroupId}`);
        },
      },
    ];
  })();

  it.each(paths.map((path) => [path.name, path] as const))(
    "hears nothing more of the table: %s",
    async (_name, path) => {
      const member = await person("reader");
      await path.give(member);
      const socket = await following(member.id);
      await change();
      expect(rowsHeard(socket.sent)).toBe(1);

      await path.take(member);
      // No heartbeat runs here: only the bus can have told that process.
      await until(
        () => socket.sent.some((message) => message.type === "stale"),
        "the page was told",
      );
      const before = socket.sent.length;
      await change();
      expect(socket.sent).toHaveLength(before);
    },
  );

  it("keeps a member who keeps a role through another way", async () => {
    const member = await person("kept");
    await admin
      .call()
      .admin.setBaseRole({ userId: member.id, baseId, role: "viewer" });
    const groupId = await localGroup(member);
    await admin
      .call()
      .admin.groups.setBaseRole({ groupId, baseId, role: "viewer" });
    const socket = await following(member.id);
    await admin.call().admin.groups.delete({ groupId });
    await hubThere.recheck();
    await change();
    expect(rowsHeard(socket.sent)).toBe(1);
    expect(socket.closed).toEqual([]);
  });

  it("ends with an administrator's opening of a base, by hand and at its hour", async () => {
    const owner = await person("owner");
    const closedBase = (await insertBase(db, owner.id, { name: "Paie" })).id;
    const closedTable = (
      await insertTable(db, owner.id, {
        baseId: closedBase,
        name: "Salaires",
        columns: [{ name: "title", fieldType: "text", label: "Title" }],
      })
    ).id;
    const open = () =>
      admin.call().admin.baseOverview.open({
        baseId: closedBase,
        reason: "Support request",
      });

    await open();
    const byHand = await following(adminId, closedTable);
    await admin.call().admin.baseOverview.close({ baseId: closedBase });
    await until(
      () => byHand.sent.some((message) => message.type === "stale"),
      "the page was told",
    );

    await open();
    const atItsHour = await following(adminId, closedTable);
    await db
      .updateTable("emergencyAccess")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("baseId", "=", closedBase)
      .where("endedAt", "is", null)
      .execute();
    // Nothing is said when an hour runs out: the heartbeat finds it.
    await hubThere.recheck();
    expect(atItsHour.sent.at(-1)).toEqual({
      type: "stale",
      channel: closedTable,
    });
  });

  it("tells a reader under a rule only that the table moved", async () => {
    const member = await person("ruled");
    await admin
      .call()
      .admin.setBaseRole({ userId: member.id, baseId, role: "viewer" });
    const socket = await following(member.id);
    await change();
    expect(socket.sent.at(-1)).toMatchObject({ rowIds: [ROW] });

    await giveTableByTable(db, adminId, { tableId, userId: member.id });
    await admin.call().catalog.setTableAcl({
      tableId,
      userId: member.id,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "title", op: "is", value: "mine" }],
      },
      columns: [],
    });
    await hubThere.recheck();
    await change();
    expect(socket.sent.at(-1)).toEqual({
      type: "rows",
      channel: tableId,
      op: "refresh",
      rowIds: [],
    });
    expect(socket.closed).toEqual([]);

    await admin.call().catalog.clearTableAcl({ tableId, userId: member.id });
    await hubThere.recheck();
    await change();
    expect(socket.sent.at(-1)).toMatchObject({ rowIds: [ROW] });
  });

  it("does the same for a field hidden from the reader", async () => {
    const member = await person("masked");
    await admin
      .call()
      .admin.setBaseRole({ userId: member.id, baseId, role: "viewer" });
    await giveTableByTable(db, adminId, { tableId, userId: member.id });
    await admin.call().catalog.setTableAcl({
      tableId,
      userId: member.id,
      rowFilter: null,
      columns: [{ column: "title", access: "hide" }],
    });
    const socket = await following(member.id);
    await change();
    expect(socket.sent.at(-1)).toEqual({
      type: "rows",
      channel: tableId,
      op: "refresh",
      rowIds: [],
    });
  });

  it("holds the rule to nobody who owns the table", async () => {
    const member = await person("co-owner");
    await enrollTotp(member.page);
    await admin
      .call()
      .admin.setBaseRole({ userId: member.id, baseId, role: "owner" });
    await giveTableByTable(db, adminId, { tableId, userId: member.id });
    // Whoever manages the table sets its rules: none can narrow them.
    expect(
      await errorCode(
        admin.call().catalog.setTableAcl({
          tableId,
          userId: member.id,
          rowFilter: {
            conjunction: "and",
            conditions: [{ column: "title", op: "is", value: "Other" }],
          },
          columns: [],
        }),
      ),
    ).toBe("rule_binds_no_manager");
    const socket = await following(member.id);
    await change();
    expect(socket.sent.at(-1)).toMatchObject({ rowIds: [ROW] });
  });

  it("answers as a single check would, for every kind of channel", async () => {
    const member = await person("mixed");
    const stranger = await person("stranger");
    const otherBase = (await insertBase(db, adminId, { name: "Autre" })).id;
    const otherTable = (
      await insertTable(db, adminId, {
        baseId: otherBase,
        name: "Other",
        columns: [{ name: "title", fieldType: "text", label: "Title" }],
      })
    ).id;
    await admin.call().catalog.setTableRole({
      tableId: otherTable,
      userId: member.id,
      role: "viewer",
    });
    const channels = [
      member.id,
      stranger.id,
      baseId,
      otherBase,
      tableId,
      otherTable,
      "00000000-0000-4000-8000-00000000ffff",
    ];
    const rights = await gridChannelRights(
      db,
      new Map([
        [member.id, new Set(channels)],
        [stranger.id, new Set(channels)],
      ]),
    );
    for (const userId of [member.id, stranger.id]) {
      for (const channel of channels) {
        const single = await authorizeGrid(db, userId, channel, "rows.read");
        expect({
          userId,
          channel,
          allowed: rights.get(userId)?.has(channel) ?? false,
        }).toEqual({ userId, channel, allowed: single === "ok" });
      }
    }
  });

  it("refuses an account the second-factor policy now stops", async () => {
    const member = await person("policy");
    await admin
      .call()
      .admin.setBaseRole({ userId: member.id, baseId, role: "owner" });
    const rights = await gridChannelRights(
      db,
      new Map([[member.id, new Set([tableId])]]),
    );
    expect(await authorizeGrid(db, member.id, tableId, "rows.read")).toBe(
      "enroll",
    );
    expect(rights.get(member.id)?.has(tableId) ?? false).toBe(false);
    await admin
      .call()
      .admin.setBaseRole({ userId: member.id, baseId, role: "viewer" });
  });
});
