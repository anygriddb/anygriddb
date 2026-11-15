/**
 * A form's public link takes answers within the time its maker set, and
 * no other: a link that has not opened or has closed says so, and refuses
 * an answer and a file from whoever calls, whatever page they kept open.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import type { ViewConfig } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAttachmentRoutes } from "../attachments.js";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { DiskStore } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode } from "../trpc/caller.test-helpers.js";
import { uploadSlots } from "../upload-slots.js";
import { loadEngine } from "./engine.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { createShare } from "./sharing.js";
import { createView } from "./views.js";

const suffix = randomBytes(6).toString("hex");
const BOUNDARY = "----anygriddb-form";
const HOUR = 3_600_000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();

describe("the time a form's public link takes answers", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let tableId = "";
  const links: Record<string, string> = {};
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const anyone = browserFactory({ db: () => db, env, hub });

  const open = (name: string) =>
    anyone()
      .call()
      .share.open({ token: links[name] ?? "" });
  const answer = (name: string) =>
    anyone()
      .call()
      .share.submit({
        token: links[name] ?? "",
        values: { title: `Sent to ${name}` },
      });
  const file = (name: string) =>
    app.inject({
      method: "POST",
      url: `/api/shares/${links[name] ?? ""}/attachments?field=files`,
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from("A note"),
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });
  const sent = async () =>
    (
      await db
        .selectFrom("auditEvents")
        .select("id")
        .where("tableId", "=", tableId)
        .where("action", "=", "insert")
        .execute()
    ).length;

  beforeAll(async () => {
    const created = await createTestDatabase("form_window");
    db = created.db;
    close = created.close;
    const owner = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const baseId = (await insertBase(db, owner.id, { name: "Survey" })).id;
    tableId = (
      await insertTable(db, owner.id, {
        baseId,
        name: "Answers",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "files", label: "Files", fieldType: "attachment" },
        ],
      })
    ).id;
    const { engine } = await loadEngine(db, tableId, () => true);
    const windows: Record<string, ViewConfig["form"]> = {
      always: {},
      open: { openFrom: at(-HOUR), openUntil: at(HOUR) },
      from: { openFrom: at(-HOUR) },
      soon: { openFrom: at(HOUR) },
      over: { openFrom: at(-2 * HOUR), openUntil: at(-HOUR) },
      until: { openUntil: at(-1_000) },
      // Ends before it starts: never open, and nothing of the form lost.
      inverted: { openFrom: at(HOUR), openUntil: at(-HOUR), title: "Kept" },
    };
    for (const [name, form] of Object.entries(windows)) {
      const view = await createView(db, engine, owner.id, {
        tableId,
        name,
        viewType: "form",
        config: { form },
        ownerId: null,
      });
      const share = await createShare(db, {
        viewId: view.id,
        createdBy: owner.id,
        allowCopy: false,
      });
      links[name] = share.token;
    }
    app = Fastify();
    await app.register(cookie);
    await registerAttachmentRoutes(app, {
      db,
      files: new DiskStore(await mkdtemp(join(tmpdir(), "ag-form-window-"))),
      encryptionKey: env.AUTH_ENCRYPTION_KEY,
      uploads: uploadSlots(4),
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it("says where each link stands, by the server's clock", async () => {
    const standing: Record<string, string | undefined> = {};
    for (const name of Object.keys(links)) {
      standing[name] = (await open(name)).view?.window;
    }
    expect(standing).toEqual({
      always: "open",
      open: "open",
      from: "open",
      soon: "not_yet",
      over: "ended",
      until: "ended",
      inverted: "ended",
    });
    // The page is told the times, to say them to its reader.
    const soon = await open("soon");
    expect(
      (soon.view?.config as { form?: { openFrom?: string } }).form?.openFrom,
    ).toMatch(/^\d{4}-/);
    const inverted = await open("inverted");
    expect(
      (inverted.view?.config as { form?: { title?: string } }).form?.title,
    ).toBe("Kept");
  });

  it("takes an answer and a file within the time, and writes the row", async () => {
    const before = await sent();
    for (const name of ["always", "open", "from"]) {
      await expect(answer(name)).resolves.toBeDefined();
      expect([name, (await file(name)).statusCode]).toEqual([name, 200]);
    }
    expect(await sent()).toBe(before + 3);
  });

  it("refuses an answer and a file before and after it, and writes nothing", async () => {
    const before = await sent();
    for (const name of ["soon", "over", "until", "inverted"]) {
      expect([name, await errorCode(answer(name))]).toEqual([
        name,
        "form_closed",
      ]);
      expect([name, (await file(name)).statusCode]).toEqual([name, 404]);
    }
    expect(await sent()).toBe(before);
  });
});
