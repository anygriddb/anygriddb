/**
 * An API token that writes without deleting (ADR 0079): it creates and
 * updates rows and is refused a delete by every door a token has, the
 * app's own API included; a token made without a word keeps deleting.
 */
import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { registerRestApi } from "../rest-api.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "../trpc/caller.test-helpers.js";
import { keyRing } from "./key-ring.js";

const suffix = randomBytes(6).toString("hex");

describe("an API token that writes without deleting", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const owner = browserFactory({ db: () => db, env, hub })();
  let tableId = "";
  let kept = "";
  let full = "";

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function addRow(title: string): Promise<string> {
    const { id } = await owner
      .call()
      .rows.insert({ tableId, values: { title } });
    return id;
  }

  async function titles(): Promise<unknown[]> {
    const page = await owner.call().rows.read({ tableId });
    return page.rows.map((row) => row.title).sort();
  }

  beforeAll(async () => {
    const created = await createTestDatabase("tokens");
    db = created.db;
    close = created.close;
    await owner.call().auth.signup({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: "correct horse battery staple",
    });
    await enrollTotp(owner);
    const baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    kept = (
      await owner.call().auth.createToken({ name: "agent", allowDelete: false })
    ).token;
    full = (await owner.call().auth.createToken({ name: "script" })).token;

    app = Fastify();
    await app.register(cookie);
    registerRestApi(app, {
      db,
      bus: recordingBus().bus,
      publicUrl: "http://localhost",
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it("creates and updates rows", async () => {
    const made = await app.inject({
      method: "POST",
      url: `/api/v1/tables/${tableId}/records`,
      headers: bearer(kept),
      payload: { records: [{ fields: { title: "Made" } }] },
    });
    expect(made.statusCode).toBe(200);
    const id = made.json<{ records: Array<{ id: string }> }>().records[0]?.id;
    expect(
      await errorCode(
        owner.call(bearer(kept)).rows.updateMany({
          tableId,
          updates: [{ rowId: id ?? "", values: { title: "Changed" } }],
        }),
      ),
    ).toBe("ok");
    expect(await titles()).toContain("Changed");
  });

  it("is refused a delete on the REST API and on the app's own", async () => {
    const id = await addRow("Stays");
    const refused = await app.inject({
      method: "DELETE",
      url: `/api/v1/tables/${tableId}/records?records=${id}`,
      headers: bearer(kept),
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe("token_cannot_delete");
    expect(
      await errorCode(
        owner.call(bearer(kept)).rows.deleteMany({ tableId, rowIds: [id] }),
      ),
    ).toBe("token_cannot_delete");
    expect(await titles()).toContain("Stays");
  });

  it("says so in the list of tokens, and leaves the other deleting", async () => {
    const { tokens } = await owner.call().auth.tokens();
    expect(
      tokens.map((token) => [token.name, token.allowDelete]).sort(),
    ).toEqual([
      ["agent", false],
      ["script", true],
    ]);
    const id = await addRow("Goes");
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/tables/${tableId}/records?records=${id}`,
      headers: bearer(full),
    });
    expect(deleted.statusCode).toBe(200);
    expect(await titles()).not.toContain("Goes");
  });
});
