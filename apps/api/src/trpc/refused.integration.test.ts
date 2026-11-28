/**
 * What a way in declares it asks, it refuses to whom lacks it. Every
 * procedure of the router is called, for each permission it declares it
 * asks, by an account that holds every other one: the check must ask that
 * permission, hear it refused, and the call must fail, having written
 * nothing. The ids it is given name a real base, its tables and what they
 * hold, so the call reaches its check rather than a missing object.
 */
import {
  INSTANCE_CALLERS,
  INSTANCE_PERMISSIONS,
  JOB_KINDS,
  type JobKind,
  type InstanceCaller,
  type InstancePermission,
  isInstancePermission,
  type MadeRole,
  PERMISSIONS,
  type Permission,
  callersHold,
} from "@anygriddb/core";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Declaration,
  type Demand,
  runDeclared,
  watchDemands,
} from "../access/declaration.js";
import { declareRoutes } from "../access/routes.js";
import { authorizeGrid } from "../auth/access.js";
import { keyRing } from "../auth/key-ring.js";
import { runQueuedAutomation } from "../automations.js";
import { registerMcp } from "../mcp/http.js";
import { OPERATION_ASKS, type Operation } from "../public-api/index.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { TASK_ASKS } from "../queue/tasks.js";
import { registerRestApi } from "../rest-api.js";
import { handleWebhookEvent } from "../webhooks.js";
import { GridHub, MESSAGE_ASKS } from "../ws.js";
import { withAudit } from "../data/audit-context.js";
import { setMemberRole } from "../data/members.js";
import { DiskStore } from "../files/index.js";
import { JOB_ASKS, jobRunners } from "../job-runners.js";
import { adminBench } from "./admin-bench.test-helpers.js";
import {
  enrollTotp,
  errorCode as code,
  signUpProved,
  type TestBrowser,
} from "./caller.test-helpers.js";
import { ask, walkRouter, type Walked } from "./router-walk.test-helpers.js";

const PASSWORD = "correct horse battery staple";

/**
 * Ways in this walk cannot bring to their check, each with why. A name
 * joins this list for such a reason, never to make the walk pass.
 */
const UNREACHED: Record<string, string> = {};

/** The objects the walk's calls are about, named as inputs name them. */
type World = {
  baseId: string;
  tableId: string;
  viewId: string;
  rowId: string;
  ownerId: string;
  [name: string]: string;
};

/**
 * Puts the world's ids where an input names one: `tableId` takes the
 * world's table, `rowIds` its row.
 */
function fill(
  value: unknown,
  world: Record<string, string>,
  key = "",
): unknown {
  if (Array.isArray(value)) {
    const one = key.endsWith("Ids")
      ? world[`${key.slice(0, -3)}Id`]
      : undefined;
    return one === undefined ? value.map((item) => fill(item, world)) : [one];
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, inner]) => [
        name,
        fill(inner, world, name),
      ]),
    );
  }
  return typeof value === "string" && world[key] !== undefined
    ? world[key]
    : value;
}

/** A socket as the hub holds one, that keeps what it is sent. */
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
    close: (closing: number) => {
      closed.push(closing);
      socket.readyState = 3;
    },
    terminate: () => {
      closed.push(1006);
      socket.readyState = 3;
    },
  });
  return { socket, sent, closed };
}

/** Waits, a few seconds at most, for what a socket's handling does. */
async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !done(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The parts of Administration, but the auditor, that lack a permission. */
function lacking(permission: InstancePermission): InstanceCaller[] {
  return INSTANCE_CALLERS.filter(
    (caller) =>
      caller !== "administrator" &&
      caller !== "auditor" &&
      !callersHold([caller], permission),
  );
}

describe("every way in refuses whom its declared permission is missing", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin: TestBrowser;
  let owner: TestBrowser;
  const world: World = {
    baseId: "",
    tableId: "",
    viewId: "",
    rowId: "",
    ownerId: "",
  };
  /** Who holds every permission of a base but one, by the one. */
  const without = new Map<Permission, TestBrowser>();
  /** Who holds every part of Administration but those that give one. */
  const lackingPart = new Map<InstancePermission, TestBrowser>();
  const heard: Demand[] = [];
  let stopHearing: () => void = () => undefined;
  const { browser, account, start } = adminBench("refused", PASSWORD);

  /** Their ids, by the one permission they lack. */
  const withoutIds = new Map<Permission, string>();
  /** The made roles of every permission but one, by the one. */
  const madeWithout = new Map<Permission, MadeRole>();
  let every: MadeRole = { id: "", name: "", permissions: [] };

  /** A role an administrator makes, as a role is given. */
  async function madeRole(
    name: string,
    permissions: Permission[],
  ): Promise<MadeRole> {
    const made = await admin.call().admin.roles.create({ name, permissions });
    return { id: made.id, name, permissions };
  }

  /** An account signed in with a second factor, by its id. */
  async function person(who: string): Promise<[TestBrowser, string]> {
    const page = browser();
    const id = await signUpProved(page, db, account(who));
    await enrollTotp(page);
    return [page, id];
  }

  beforeAll(async () => {
    const bench = await start();
    ({ db, close, admin } = bench);
    let ownerId = "";
    [owner, ownerId] = await person("owner");
    const base = await owner.call().catalog.createBase({ name: "World" });
    world.baseId = base.id;
    const table = await owner.call().catalog.createTable({
      baseId: base.id,
      name: "Samples",
      columns: [{ name: "ref", label: "Ref", fieldType: "text" }],
    });
    world.tableId = table.id;
    world.targetTableId = (
      await owner.call().catalog.createTable({
        baseId: base.id,
        name: "Sites",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    world.rowId = (
      await owner
        .call()
        .rows.insert({ tableId: table.id, values: { ref: "A" } })
    ).id;
    world.viewId = (
      await owner.call().catalog.createView({
        tableId: table.id,
        name: "All",
        viewType: "grid",
      })
    ).id;
    world.commentId = (
      await owner.call().rows.addComment({
        tableId: table.id,
        rowId: world.rowId,
        body: "Checked",
      })
    ).id;
    world.parentId = world.commentId;
    world.dashboardId = (
      await owner.call().dashboards.create({ baseId: base.id, name: "Board" })
    ).id;
    world.widgetId = (
      await owner.call().dashboards.upsertWidget({
        dashboardId: world.dashboardId,
        title: "Count",
        kind: "metric",
        config: { tableId: table.id, column: "ref", fn: "count_all" },
      })
    ).id;
    world.folderId = (
      await owner.call().catalog.createFolder({ baseId: base.id, name: "Kept" })
    ).id;
    // Made beside the API: saving one resolves its address, and this
    // bench has no network.
    world.webhookId = await withAudit(
      db,
      { userId: ownerId, tableId: table.id, source: "web" },
      async (tx) =>
        (
          await tx
            .insertInto("webhooks")
            .values({
              tableId: table.id,
              createdBy: ownerId,
              kind: "http",
              name: "Out",
              target: "https://hooks.example.org/in",
              events: ["insert"],
              secretCiphertext: Buffer.alloc(16),
              secretNonce: Buffer.alloc(12),
            })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id,
    );
    world.deliveryId = (
      await db
        .insertInto("deliveries")
        .values({
          webhookId: world.webhookId,
          event: "insert",
          rowId: world.rowId,
          status: "failed",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    // A restore point is a job's work: its line is enough to be refused.
    world.restorePointId = (
      await db
        .insertInto("restorePoints")
        .values({
          baseId: base.id,
          createdBy: ownerId,
          expiresAt: new Date(Date.now() + 86_400_000),
          fileKey: `restore/${base.id}.agsnap`,
          size: 0,
          rows: 0,
          files: 0,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    world.automationId = (
      await owner.call().automations.create({
        tableId: table.id,
        name: "Noted",
        trigger: { type: "row_created" },
        actions: [{ type: "update_record", values: { ref: "B" } }],
      })
    ).id;
    world.shareId = (
      await owner.call().catalog.createShare({ viewId: world.viewId })
    ).id;
    world.ownerId = ownerId;
    world.userId = ownerId;
    // Every role made of all permissions but one, and who holds each.
    for (const missing of PERMISSIONS) {
      const [page, id] = await person(`without-${missing}`);
      without.set(missing, page);
      withoutIds.set(missing, id);
      if (missing === "rows.read") continue;
      const role = await madeRole(
        `Without ${missing}`,
        PERMISSIONS.filter((held) => held !== missing),
      );
      madeWithout.set(missing, role);
      await setMemberRole(db, ownerId, {
        baseId: base.id,
        userId: id,
        role,
      });
    }
    every = await madeRole("Every permission", [...PERMISSIONS]);
    // Every part of Administration but those that give one permission.
    for (const permission of INSTANCE_PERMISSIONS) {
      const [page, id] = await person(`lacking-${permission}`);
      lackingPart.set(permission, page);
      for (const part of lacking(permission)) {
        if (part === "support") {
          await admin.call().admin.setSupport({ userId: id, support: true });
        } else if (part === "account_manager" || part === "source_manager") {
          await admin
            .call()
            .admin.setInstanceRole({ userId: id, role: part, granted: true });
        }
      }
    }
    // Only an administrator makes a base: so `bases.create` is asked.
    await admin.call().admin.updateSettings({ baseCreation: "admins" });
    stopHearing = watchDemands((demanded) => heard.push(demanded));
  }, 300_000);

  afterAll(async () => {
    stopHearing();
    await close?.();
  });

  /** How many events the change trail holds. */
  const trailed = async () =>
    Number(
      (
        await db
          .selectFrom("auditEvents")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .executeTakeFirstOrThrow()
      ).n,
    );

  /** Who lacks a permission, for a way in that asks it. */
  const caller = (permission: Permission | InstancePermission) =>
    isInstancePermission(permission)
      ? permission === "bases.create"
        ? without.get("rows.read")
        : lackingPart.get(permission)
      : without.get(permission);

  it("refuses each procedure to whom lacks a permission it declares it asks", async () => {
    // What the plain input cannot name: a revert of the base itself.
    const about: Record<string, Record<string, unknown>> = {
      "catalog.earlier": { kind: "base", id: world.baseId },
      "catalog.revert": { kind: "base", id: world.baseId },
      // A role's end names its base or table as a scope (ADR 0146).
      "catalog.setRoleEnd": { scope: "base", scopeId: world.baseId },
    };
    const procedures: Walked[] = walkRouter().map((walked) => ({
      ...walked,
      input:
        about[walked.path] === undefined
          ? walked.input
          : { ...(walked.input as object), ...about[walked.path] },
    }));
    const notAsked: string[] = [];
    const passed: string[] = [];
    const wrote: string[] = [];
    let walked = 0;
    for (const { path, input, declaration } of procedures) {
      if (UNREACHED[path] !== undefined) continue;
      for (const permission of declaration.asks ?? []) {
        // A public link asks of its maker: walked apart, below.
        if (declaration.exception === "publicLink") continue;
        const page = caller(permission);
        if (!page) throw new Error(`nobody lacks ${permission}`);
        walked += 1;
        heard.length = 0;
        const before = await trailed();
        const answer = await code(ask(page, path, fill(input, world)));
        const refused = heard.some(
          (demanded) => demanded.permission === permission && !demanded.granted,
        );
        if (!refused) notAsked.push(`${path} ${permission} (${answer})`);
        else if (answer === "ok") passed.push(`${path} ${permission}`);
        if ((await trailed()) !== before) wrote.push(`${path} ${permission}`);
      }
    }
    expect(notAsked).toEqual([]);
    expect(passed).toEqual([]);
    expect(wrote).toEqual([]);
    // Every procedure but the open ones asks something of its caller.
    expect(walked).toBeGreaterThan(250);
  }, 600_000);

  /** Sets, or takes away, a person's role on the world's base. */
  async function giveOnBase(userId: string, role: MadeRole | null) {
    if (role) {
      await setMemberRole(db, world.ownerId, {
        baseId: world.baseId,
        userId,
        role,
      });
      return;
    }
    await withAudit(db, { userId: world.ownerId, source: "web" }, (tx) =>
      tx
        .deleteFrom("attributions")
        .where("userId", "=", userId)
        .where("scopeId", "=", world.baseId)
        .execute(),
    );
  }

  /** Whether the check asked this permission and heard it refused. */
  const refusedAsked = (permission: string) =>
    heard.some(
      (demanded) => demanded.permission === permission && !demanded.granted,
    );

  it("refuses a public link whose maker no longer holds what it asks", async () => {
    const [linker, linkerId] = await person("linker");
    await giveOnBase(linkerId, every);
    const form = await linker.call().catalog.createView({
      tableId: world.tableId,
      name: "Ask",
      viewType: "form",
    });
    const links = {
      view: await linker.call().catalog.createShare({
        viewId: world.viewId,
        embedOrigins: null,
      }),
      form: await linker.call().catalog.createShare({
        viewId: form.id,
        embedOrigins: null,
      }),
      base: await linker
        .call()
        .catalog.createBaseShare({ baseId: world.baseId }),
    };
    const stranger = browser();
    const walks: Array<[string, Record<string, unknown>]> = [
      ["share.open", { token: links.view.token }],
      ["share.rows", { token: links.view.token, limit: 10 }],
      ["share.submit", { token: links.form.token, values: { ref: "C" } }],
      ["share.openBase", { token: links.base.token }],
      [
        "share.baseRows",
        {
          token: links.base.token,
          tableId: world.tableId,
          limit: 10,
        },
      ],
    ];
    const declared = new Map(
      walkRouter().map(({ path, declaration }) => [path, declaration] as const),
    );
    const missed: string[] = [];
    let walked = 0;
    for (const [path, input] of walks) {
      for (const permission of declared.get(path)?.asks ?? []) {
        if (isInstancePermission(permission)) continue;
        await giveOnBase(
          linkerId,
          permission === "rows.read"
            ? null
            : (madeWithout.get(permission) ?? null),
        );
        heard.length = 0;
        const answer = await code(ask(stranger, path, input));
        if (!refusedAsked(permission) || answer === "ok") {
          missed.push(`${path} ${permission} (${answer})`);
        }
        walked += 1;
      }
      await giveOnBase(linkerId, every);
    }
    expect(missed).toEqual([]);
    expect(walked).toBeGreaterThanOrEqual(14);
  });

  it("refuses each operation of the REST API and MCP to a token whose role lacks what it asks", async () => {
    const app = Fastify();
    declareRoutes(app);
    await app.register(cookie);
    const deps = {
      db,
      bus: recordingBus().bus,
      publicUrl: "https://grid.example.org",
    };
    registerRestApi(app, deps);
    registerMcp(app, deps);
    await app.ready();
    try {
      const tokens = new Map<Permission, string>();
      for (const [permission, page] of without) {
        const made = await page.call().auth.createToken({ name: "Walk" });
        tokens.set(permission, made.token);
      }
      const records = `/api/v1/tables/${world.tableId}/records`;
      const rest: Array<[Operation, string, string, unknown]> = [
        ["listRecords", "GET", records, undefined],
        ["getRecord", "GET", `${records}/${world.rowId}`, undefined],
        [
          "createRecords",
          "POST",
          records,
          { records: [{ fields: { ref: "D" } }] },
        ],
        [
          "updateRecords",
          "PATCH",
          records,
          {
            records: [{ id: world.rowId, fields: { ref: "E" } }],
          },
        ],
        [
          "transitionRecord",
          "POST",
          `${records}/${world.rowId}/transition`,
          {
            transition: "submit",
          },
        ],
        [
          "deleteRecords",
          "DELETE",
          `${records}?records=${world.rowId}`,
          undefined,
        ],
      ];
      const tools: Record<string, [string, Record<string, unknown>]> = {
        listRecords: ["list_records", { tableId: world.tableId }],
        getRecord: [
          "get_record",
          { tableId: world.tableId, recordId: world.rowId },
        ],
        createRecords: [
          "create_records",
          {
            tableId: world.tableId,
            records: [{ fields: { ref: "D" } }],
          },
        ],
        updateRecords: [
          "update_records",
          {
            tableId: world.tableId,
            records: [{ id: world.rowId, fields: { ref: "E" } }],
          },
        ],
        transitionRecord: [
          "transition_record",
          {
            tableId: world.tableId,
            recordId: world.rowId,
            transition: "submit",
          },
        ],
        deleteRecords: [
          "delete_records",
          {
            tableId: world.tableId,
            recordIds: [world.rowId],
          },
        ],
      };
      const missed: string[] = [];
      let walked = 0;
      for (const [operation, method, url, body] of rest) {
        const declared: Declaration = OPERATION_ASKS[operation];
        for (const permission of declared.asks ?? []) {
          if (isInstancePermission(permission)) continue;
          const authorization = `Bearer ${tokens.get(permission) ?? ""}`;
          heard.length = 0;
          const answer = await app.inject({
            method,
            url,
            headers: { authorization },
            ...(body === undefined ? {} : { payload: body as object }),
          });
          if (!refusedAsked(permission) || answer.statusCode < 400) {
            missed.push(
              `REST ${operation} ${permission} (${String(answer.statusCode)})`,
            );
          }
          const [tool, args] = tools[operation] ?? ["", {}];
          heard.length = 0;
          const called = await app.inject({
            method: "POST",
            url: "/mcp",
            headers: {
              authorization,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2025-06-18",
            },
            payload: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: tool, arguments: args },
            },
          });
          const said = called.json<{ result?: { isError?: boolean } }>();
          walked += 1;
          if (!refusedAsked(permission) || said.result?.isError !== true) {
            missed.push(
              `MCP ${tool} ${permission} (${called.body.slice(0, 80)})`,
            );
          }
        }
      }
      expect(missed).toEqual([]);
      expect(walked).toBe(10);
    } finally {
      await app.close();
    }
  });

  it("refuses each message a page sends on its socket to whom lacks what it asks", async () => {
    const hub = new GridHub(
      recordingBus().bus,
      db,
      (userId, channel, action) => authorizeGrid(db, userId, channel, action),
      () => undefined,
    );
    const missed: string[] = [];
    const messages: Array<
      [keyof typeof MESSAGE_ASKS, Record<string, unknown>]
    > = [
      ["subscribe", { type: "subscribe", channel: world.tableId }],
      ["presence", { type: "presence", channel: world.tableId }],
      [
        "lock",
        {
          type: "lock",
          channel: world.tableId,
          rowId: world.rowId,
          column: "ref",
        },
      ],
    ];
    for (const [kind, message] of messages) {
      for (const permission of MESSAGE_ASKS[kind].asks ?? []) {
        if (isInstancePermission(permission)) continue;
        const userId = withoutIds.get(permission) ?? "";
        const opened = fakeSocket();
        hub.add(opened.socket as never, userId, "Walker");
        heard.length = 0;
        opened.socket.emit("message", JSON.stringify(message));
        await until(() => heard.length > 0 || opened.closed.length > 0);
        if (!refusedAsked(permission)) missed.push(`${kind} ${permission}`);
        if (opened.sent.some((sent) => sent.type === "subscribed")) {
          missed.push(`${kind} ${permission} (subscribed)`);
        }
        opened.socket.emit("close");
      }
    }
    expect(missed).toEqual([]);
    expect(heard.length).toBeGreaterThan(0);
  });

  it("refuses each kind of job to an author who lacks what it asks", async () => {
    const runners = jobRunners({
      db,
      bus: recordingBus().bus,
      files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-refused-"))),
      log: () => undefined,
    });
    const inputs: Partial<Record<JobKind, unknown>> = {
      export: { tableId: world.tableId, format: "csv" },
      duplicate_table: {
        tableId: world.tableId,
        name: "Copy",
        withData: false,
      },
      export_snapshot: { baseId: world.baseId, withData: true },
      duplicate_base: { baseId: world.baseId, name: "Copy", withData: false },
      restore_point: { baseId: world.baseId },
      restore_base: { restorePointId: world.restorePointId },
      convert_column: {
        tableId: world.tableId,
        name: "ref",
        fieldType: "number",
      },
      account_export: { userId: world.ownerId },
      // Refused before the file they would read is looked for.
      import_snapshot: { snapshotId: "a".repeat(22) },
      import_workbook: {
        importId: randomUUID(),
        name: "Book",
        sheets: [0],
      },
      import_airtable: {
        airtableBaseId: `app${"a".repeat(14)}`,
        token: { ciphertext: "sealed", nonce: "once" },
      },
    };
    const missed: string[] = [];
    let walked = 0;
    for (const kind of JOB_KINDS) {
      const input = inputs[kind];
      if (input === undefined) continue;
      for (const permission of JOB_ASKS[kind].asks ?? []) {
        const userId = isInstancePermission(permission)
          ? (withoutIds.get("rows.read") ?? "")
          : (withoutIds.get(permission) ?? "");
        heard.length = 0;
        const outcome = await code(
          runDeclared(`job.${kind}`, JOB_ASKS[kind], () =>
            runners[kind]({
              job: {
                id: randomUUID(),
                kind,
                userId,
                baseId: world.baseId,
                tableId: world.tableId,
                input,
              } as never,
              progress: async () => undefined,
            }),
          ),
        );
        walked += 1;
        if (!refusedAsked(permission) || outcome === "ok") {
          missed.push(`${kind} ${permission} (${outcome})`);
        }
      }
    }
    expect(missed).toEqual([]);
    expect(walked).toBeGreaterThanOrEqual(13);
  });

  it("refuses each task in someone's name when they lack what it asks", async () => {
    const missed: string[] = [];
    // A webhook delivers as its maker reads, and only while they export.
    for (const permission of TASK_ASKS.webhooks_event.asks ?? []) {
      const maker = withoutIds.get(permission as Permission) ?? "";
      const hook = await withAudit(
        db,
        { userId: maker, tableId: world.tableId, source: "web" },
        async (tx) =>
          (
            await tx
              .insertInto("webhooks")
              .values({
                tableId: world.tableId,
                createdBy: maker,
                kind: "http",
                name: `Without ${permission}`,
                target: "https://hooks.example.org/in",
                events: ["update"],
                secretCiphertext: Buffer.alloc(16),
                secretNonce: Buffer.alloc(12),
              })
              .returning("id")
              .executeTakeFirstOrThrow()
          ).id,
      );
      heard.length = 0;
      await runDeclared("task.webhooks_event", TASK_ASKS.webhooks_event, () =>
        handleWebhookEvent(
          {
            db,
            key: keyRing(randomBytes(32)),
            smtp: {},
            log: () => undefined,
          },
          { tableId: world.tableId, event: "update", rowId: world.rowId },
        ),
      );
      const delivered = await db
        .selectFrom("deliveries")
        .select("id")
        .where("webhookId", "=", hook)
        .execute();
      if (!refusedAsked(permission) || delivered.length > 0) {
        missed.push(`webhooks_event ${permission}`);
      }
    }
    // An automation runs as its author, and writes only while they may.
    const author = withoutIds.get("rows.write") ?? "";
    const automation = await withAudit(
      db,
      { userId: author, tableId: world.tableId, source: "web" },
      async (tx) =>
        (
          await tx
            .insertInto("automations")
            .values({
              tableId: world.tableId,
              createdBy: author,
              name: "Without rows.write",
              trigger: { type: "row_created" },
              actions: [{ type: "update_record", values: { ref: "F" } }],
            } as never)
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id,
    );
    heard.length = 0;
    await runDeclared("task.automation_run", TASK_ASKS.automation_run, () =>
      runQueuedAutomation(
        {
          db,
          bus: recordingBus().bus,
          smtp: {},
          webOrigin: "https://grid.example.org",
          log: () => undefined,
        },
        {
          automationId: automation,
          event: {
            tableId: world.tableId,
            event: "insert",
            rowId: world.rowId,
            depth: 0,
          },
        },
      ),
    );
    if (!refusedAsked("rows.write")) missed.push("automation_run rows.write");
    expect(missed).toEqual([]);
  });

  it("names in its list only what the router has", () => {
    const known = new Set(walkRouter().map(({ path }) => path));
    expect(Object.keys(UNREACHED).filter((path) => !known.has(path))).toEqual(
      [],
    );
  });
});
