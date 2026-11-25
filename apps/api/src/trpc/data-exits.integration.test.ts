/**
 * Rows leave a base only through an export, and a token reaches a base
 * only through a role that lets one in (ADR 0129). A role made without
 * either reads and writes in the application, and takes nothing out:
 * neither when something is made (a link, a webhook, an automation, a
 * copy) nor when it is used later, by the roles its maker holds then.
 */
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestActor } from "../auth/access.js";
import { createApiToken } from "../auth/tokens.js";
import { setTableAcl } from "../data/acl.js";
import { runAutomation, type AutomationDeps } from "../automations.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { adminBench } from "./admin-bench.test-helpers.js";
import {
  enrollTotp,
  errorCode,
  joinBase,
  signUpProved,
  type TestBrowser,
} from "./caller.test-helpers.js";

const PASSWORD = "correct horse battery staple";

/** What a role made to write, publish and build, but not to export, holds. */
const KEEPS = [
  "rows.read",
  "rows.write",
  "publish",
  "views.manage",
  "webhooks.manage",
  "automations.manage",
  "schema.manage",
] as const;

describe("what takes rows out of a base", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin: TestBrowser;
  let owner: TestBrowser;
  /** Holds `KEEPS`: no export, no token's way in. */
  let member: TestBrowser;
  /** Holds `KEEPS` with the export and a token's way in. */
  let exporter: TestBrowser;
  let viewer: TestBrowser;
  /** Manages the base and publishes, but does not export. */
  let keeper: TestBrowser;
  const visitor = () => owner;
  const ids = {
    owner: "",
    member: "",
    exporter: "",
    viewer: "",
    keeper: "",
    base: "",
    samples: "",
    secrets: "",
    grid: "",
    form: "",
    keeps: "",
    takes: "",
    stewards: "",
  };
  const { browser, account, start } = adminBench("data-exits", PASSWORD);

  /** Gives someone a role on the base, one of the four or a made one. */
  const give = (who: string, role: string) =>
    owner.call().catalog.grant({
      baseId: ids.base,
      email: account(who).email,
      role,
    });

  const bearer = async (userId: string) => ({
    authorization: `Bearer ${(await createApiToken(db, userId, "Script", { days: 1 })).token}`,
  });

  beforeAll(async () => {
    const bench = await start();
    ({ db, close, admin } = bench);
    owner = browser();
    ids.owner = await signUpProved(owner, db, account("owner"));
    await enrollTotp(owner);
    ids.base = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    for (const [key, name] of [
      ["samples", "Samples"],
      ["secrets", "Secrets"],
    ] as const) {
      ids[key] = (
        await owner.call().catalog.createTable({
          baseId: ids.base,
          name,
          columns: [{ name: "ref", label: "Ref", fieldType: "text" }],
        })
      ).id;
      await owner
        .call()
        .rows.insert({ tableId: ids[key], values: { ref: `${name} 1` } });
    }
    ids.grid = (
      await owner.call().catalog.createView({
        tableId: ids.samples,
        name: "Shared",
        viewType: "grid",
      })
    ).id;
    ids.form = (
      await owner.call().catalog.createView({
        tableId: ids.samples,
        name: "Intake",
        viewType: "form",
      })
    ).id;
    ids.keeps = (
      await admin.call().admin.roles.create({
        name: "Builder",
        permissions: [...KEEPS],
      })
    ).id;
    ids.takes = (
      await admin.call().admin.roles.create({
        name: "Builder who exports",
        permissions: [...KEEPS, "data.export", "api.access"],
      })
    ).id;
    ids.stewards = (
      await admin.call().admin.roles.create({
        name: "Steward",
        permissions: ["rows.read", "base.manage", "publish"],
      })
    ).id;
    member = browser();
    ids.member = await signUpProved(member, db, account("member"));
    exporter = browser();
    ids.exporter = await signUpProved(exporter, db, account("exporter"));
    viewer = browser();
    ids.viewer = await signUpProved(viewer, db, account("viewer"));
    keeper = browser();
    ids.keeper = await signUpProved(keeper, db, account("keeper"));
    // A role that manages the base asks a second factor of its holder.
    await enrollTotp(keeper);
    for (const userId of [ids.member, ids.exporter, ids.viewer, ids.keeper]) {
      await joinBase(db, { baseId: ids.base, userId, role: "viewer" });
    }
    await give("member", ids.keeps);
    await give("exporter", ids.takes);
    await give("keeper", ids.stewards);
  }, 180_000);

  afterAll(async () => {
    await close?.();
  });

  it("lets a token in only through a role that gives it a way in", async () => {
    const read = (who: TestBrowser, headers: Record<string, string> = {}) =>
      who.call(headers).rows.read({ tableId: ids.samples, limit: 10 });
    // Each of the four lets a token in: a viewer's token reads as before.
    expect((await read(viewer, await bearer(ids.viewer))).rows).toHaveLength(1);
    // A role made without it reads in the application, never by a token.
    expect((await read(member)).rows).toHaveLength(1);
    expect(await errorCode(read(member, await bearer(ids.member)))).toBe(
      "access_denied",
    );
    const actor = await requestActor(db, await bearer(ids.member), undefined);
    expect(actor?.bindings).toEqual([]);
    expect(
      (await read(exporter, await bearer(ids.exporter))).rows,
    ).toHaveLength(1);

    // A table's role that lets no token in stands over the base's there.
    await owner.call().catalog.setTableRole({
      tableId: ids.secrets,
      userId: ids.exporter,
      role: ids.keeps,
    });
    const token = await bearer(ids.exporter);
    expect(
      await errorCode(
        exporter.call(token).rows.read({ tableId: ids.secrets, limit: 10 }),
      ),
    ).toBe("access_denied");
    expect((await read(exporter, token)).rows).toHaveLength(1);
    expect(
      (await exporter.call().rows.read({ tableId: ids.secrets, limit: 10 }))
        .rows,
    ).toHaveLength(1);
    await owner.call().catalog.setTableRole({
      tableId: ids.secrets,
      userId: ids.exporter,
      role: null,
    });
  });

  it("makes a view's link only for who may export, and opens it only while they may", async () => {
    expect(
      await errorCode(member.call().catalog.createShare({ viewId: ids.grid })),
    ).toBe("access_denied");
    // A form's link takes answers in: publishing is enough.
    expect(
      (await member.call().catalog.createShare({ viewId: ids.form })).token,
    ).toBeTruthy();
    const link = await exporter
      .call()
      .catalog.createShare({ viewId: ids.grid });
    const rows = () => visitor().call().share.rows({ token: link.token });
    expect((await rows()).total).toBe(1);

    await give("exporter", ids.keeps);
    expect(await errorCode(rows())).toBe("unknown_share");
    await give("exporter", ids.takes);
    expect((await rows()).total).toBe(1);

    await db
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", ids.exporter)
      .execute();
    expect(await errorCode(rows())).toBe("unknown_share");
    await db
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", ids.exporter)
      .execute();
    expect((await rows()).total).toBe(1);
  });

  it("makes a base's link only for who manages, publishes and exports it", async () => {
    expect(
      await errorCode(
        keeper.call().catalog.createBaseShare({ baseId: ids.base }),
      ),
    ).toBe("access_denied");
  });

  it("keeps webhooks to who may export", async () => {
    const hook = (who: TestBrowser) =>
      who.call().catalog.createWebhook({
        tableId: ids.samples,
        kind: "smtp",
        target: "audit@example.org",
        events: ["insert"],
      });
    expect(await errorCode(hook(member))).toBe("access_denied");
    expect((await hook(exporter)).id).toBeTruthy();
  });

  it("keeps automations that send values out to who may export, saved and run", async () => {
    const mail = {
      type: "send_email" as const,
      to: "audit@example.org",
      subject: "New row",
      body: "{{ref}}",
    };
    const create = (who: TestBrowser, actions: unknown[]) =>
      who.call().automations.create({
        tableId: ids.samples,
        name: "Notice",
        trigger: { type: "row_created" },
        actions: actions as never,
      });
    expect(await errorCode(create(member, [mail]))).toBe("access_denied");
    // A row made in another table takes values there.
    expect(
      await errorCode(
        create(member, [
          {
            type: "create_record",
            tableId: ids.secrets,
            values: { ref: "{{ref}}" },
          },
        ]),
      ),
    ).toBe("access_denied");
    // Values that stay in their table ask nothing more.
    expect(
      (
        await create(member, [
          { type: "update_record", values: { ref: "seen" } },
        ])
      ).id,
    ).toBeTruthy();

    const saved = await create(exporter, [mail]);
    const deps: AutomationDeps = {
      db,
      bus: recordingBus().bus,
      smtp: {},
      webOrigin: "https://grid.example.org",
      log: () => undefined,
    };
    const stored = () =>
      db
        .selectFrom("automations")
        .selectAll()
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow();
    const row = (
      await owner
        .call()
        .rows.insert({ tableId: ids.samples, values: { ref: "Run" } })
    ).id;
    const run = async () =>
      runAutomation(deps, await stored(), {
        rowId: row,
        depth: 0,
        trigger: "row_created",
      });
    expect((await run()).error).not.toBe("Access denied");
    await give("exporter", ids.keeps);
    expect(await run()).toEqual({ status: "failed", error: "Access denied" });
    await give("exporter", ids.takes);
    expect((await run()).error).not.toBe("Access denied");
  });

  it("copies a table with its rows only for who may export, and whom no rule binds there", async () => {
    const copy = (who: TestBrowser, withData: boolean) =>
      who.call().catalog.duplicateTable({ tableId: ids.samples, withData });
    expect(await errorCode(copy(member, true))).toBe("access_denied");
    expect((await copy(member, false)).jobId).toBeTruthy();
    expect((await copy(exporter, true)).jobId).toBeTruthy();
    // A copy carries no rule: whom one binds here copies no row.
    await setTableAcl(db, ids.owner, {
      tableId: ids.samples,
      userId: ids.exporter,
      rowFilter: null,
      columns: [{ column: "ref", access: "read" }],
    });
    expect(await errorCode(copy(exporter, true))).toBe("copy_under_rules");
    expect((await copy(exporter, false)).jobId).toBeTruthy();
  });

  it("copies a base with its rows only for who may export", async () => {
    const copy = (withData: boolean) =>
      keeper.call().catalog.duplicateBase({ baseId: ids.base, withData });
    expect(await errorCode(copy(true))).toBe("access_denied");
    expect((await copy(false)).jobId).toBeTruthy();
  });
});
