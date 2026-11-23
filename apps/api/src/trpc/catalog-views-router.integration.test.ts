/**
 * The open screens of a base are told when the views of a table change,
 * against a real database: for a view everyone of the table sees, and not
 * for a person's own.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, enrollTotp } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("the views of a table, told to the open screens of its base", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const recorder = recordingBus();
  const owner = browserFactory({
    db: () => db,
    env,
    hub,
    bus: () => recorder.bus,
  })();
  let baseId = "";
  let tableId = "";

  /** What was told of views since `from`, as the pages hear it. */
  const told = (from: number) =>
    recorder.published
      .slice(from)
      .map((item) => item.message)
      .filter((message) => (message as { type?: string }).type === "views");

  beforeAll(async () => {
    const created = await createTestDatabase("views_told");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: "correct horse battery staple",
    });
    await enrollTotp(owner);
    baseId = (await owner.call().catalog.createBase({ name: "Ledger" })).id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("tells a shared view made, changed, copied, ordered, and removed", async () => {
    const heard = { type: "views", channel: baseId, tableId };
    let from = recorder.published.length;
    const view = await owner.call().catalog.createView({
      tableId,
      name: "Review",
      viewType: "grid",
    });
    expect(told(from)).toEqual([heard]);

    from = recorder.published.length;
    await owner
      .call()
      .catalog.updateView({ viewId: view.id, name: "Reviewed" });
    expect(told(from)).toEqual([heard]);

    from = recorder.published.length;
    const copy = await owner.call().catalog.duplicateView({ viewId: view.id });
    expect(told(from)).toEqual([heard]);

    from = recorder.published.length;
    await owner
      .call()
      .catalog.reorderViews({ tableId, order: [copy.id, view.id] });
    expect(told(from)).toEqual([heard]);

    from = recorder.published.length;
    await owner.call().catalog.deleteView({ viewId: copy.id });
    expect(told(from)).toEqual([heard]);
  });

  it("tells nobody of a person's own view", async () => {
    const from = recorder.published.length;
    const mine = await owner.call().catalog.createView({
      tableId,
      name: "Mine",
      viewType: "grid",
      personal: true,
    });
    await owner.call().catalog.updateView({ viewId: mine.id, name: "My own" });
    await owner.call().catalog.deleteView({ viewId: mine.id });
    expect(told(from)).toEqual([]);
  });
});
