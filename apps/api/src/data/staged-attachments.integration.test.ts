/**
 * Files sent to a public form (ADR 0062): kept for the link that asked,
 * served to nobody, claimed once by that link's answer in the row's own
 * transaction, refused to any other write, and purged with their bytes
 * once their deadline has passed.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertAttachmentKeys,
  registerAttachmentRoutes,
} from "../attachments.js";
import { createApiToken } from "../auth/tokens.js";
import type { Env } from "../env.js";
import { DiskStore } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode } from "../trpc/caller.test-helpers.js";
import { uploadSlots } from "../upload-slots.js";
import { withAudit } from "./audit-context.js";
import { loadEngine } from "./engine.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { createShare, issueShareAccess } from "./sharing.js";
import {
  claimStagedAttachments,
  purgeStagedAttachments,
} from "./staged-attachments.js";
import { createView } from "./views.js";

const suffix = randomBytes(6).toString("hex");
const BOUNDARY = "----anygriddb-form";

describe("files sent to a public form", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let store: DiskStore;
  let owner = "";
  let editorToken = "";
  let tableId = "";
  let physical = "";
  let form = { id: "", token: "" };
  let locked = { id: "", token: "" };
  let grid = { id: "", token: "" };
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });

  function send(
    token: string,
    field: string,
    headers: Record<string, string> = {},
    name = "devis.txt",
  ) {
    return app.inject({
      method: "POST",
      url: `/api/shares/${token}/attachments?field=${field}`,
      headers: {
        ...headers,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from("Bon pour accord"),
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });
  }

  async function staged(token: string, headers: Record<string, string> = {}) {
    const response = await send(token, "files", headers);
    expect(response.statusCode).toBe(200);
    return response.json<{ key: string }>().key;
  }

  function answer(token: string, values: Record<string, unknown>) {
    return browser()
      .call()
      .share.submit({ token, values: values as never });
  }

  async function stagedShare(key: string) {
    const row = await db
      .selectFrom("attachments")
      .select(["stagedShareId", "stagedUntil"])
      .where("key", "=", key)
      .executeTakeFirst();
    return row;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("staged_attachments");
    db = created.db;
    close = created.close;
    store = new DiskStore(await mkdtemp(join(tmpdir(), "ag-form-files-")));
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.org`, displayName: "Owner" },
        { email: `editor-${suffix}@example.org`, displayName: "Editor" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    const editor = people[1]?.id ?? "";
    const baseId = (await insertBase(db, owner, { name: "Achats" })).id;
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: editor,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    // An editor's token: an owner's would first need a second factor.
    editorToken = (await createApiToken(db, editor, "files")).token;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Demandes",
        columns: [
          { name: "title", label: "Objet", fieldType: "text" },
          { name: "files", label: "Pièces", fieldType: "attachment" },
        ],
      })
    ).id;
    const { engine } = await loadEngine(db, tableId, () => true);
    physical = engine.table.physicalName;
    const view = (name: string, viewType: "form" | "grid") =>
      createView(db, engine, { tableId, name, viewType, ownerId: null });
    const formView = await view("Dépôt", "form");
    form = await createShare(db, {
      viewId: formView.id,
      createdBy: owner,
      allowCopy: false,
    });
    locked = await createShare(db, {
      viewId: (await view("Dépôt protégé", "form")).id,
      createdBy: owner,
      password: "a long enough password",
      allowCopy: false,
    });
    grid = await createShare(db, {
      viewId: (await view("Liste", "grid")).id,
      createdBy: owner,
      allowCopy: false,
    });
    app = Fastify();
    await app.register(cookie);
    await registerAttachmentRoutes(app, {
      db,
      files: store,
      encryptionKey: env.AUTH_ENCRYPTION_KEY,
      uploads: uploadSlots(4),
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it("keeps a file for the link that sent it, and serves it to nobody", async () => {
    const response = await send(form.token, "files");
    expect(response.statusCode).toBe(200);
    const sent = response.json<Record<string, unknown>>();
    // Its name, size, and key: nothing else of the stored file.
    expect(Object.keys(sent).sort()).toEqual(["filename", "key", "size"]);
    expect(sent).toMatchObject({ filename: "devis.txt", size: 15 });
    const key = String(sent.key);
    const row = await db
      .selectFrom("attachments")
      .select(["tableId", "createdBy", "stagedShareId", "stagedUntil"])
      .where("key", "=", key)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      tableId,
      createdBy: owner,
      stagedShareId: form.id,
    });
    const hours = ((row.stagedUntil?.getTime() ?? 0) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
    // A member of the base cannot read it while it waits.
    const read = await app.inject({
      method: "GET",
      url: `/api/attachments/${key}`,
      headers: { authorization: `Bearer ${editorToken}` },
    });
    expect(read.statusCode).toBe(404);
  });

  it("refuses a field the form does not take, another kind of link, and a locked one", async () => {
    expect((await send(form.token, "title")).statusCode).toBe(404);
    expect((await send(form.token, "nothing")).statusCode).toBe(404);
    expect((await send(grid.token, "files")).statusCode).toBe(404);
    expect((await send("not-a-token", "files")).statusCode).toBe(404);
    expect(
      (await send(randomBytes(32).toString("base64url"), "files")).statusCode,
    ).toBe(404);
    // A link with a password: only with the proof its password gave.
    expect((await send(locked.token, "files")).statusCode).toBe(404);
    const proof = issueShareAccess(env.AUTH_ENCRYPTION_KEY, locked.id);
    expect(
      (await send(locked.token, "files", { "x-share-access": proof }))
        .statusCode,
    ).toBe(200);
  });

  it("lets the link's answer claim its files once, and no other write", async () => {
    const key = await staged(form.token);
    // A member's write cannot name a file that waits for an answer.
    await expect(
      assertAttachmentKeys(db, tableId, [key]),
    ).rejects.toMatchObject({ code: "invalid_attachment" });
    // Nor can another link's answer.
    const proof = issueShareAccess(env.AUTH_ENCRYPTION_KEY, locked.id);
    expect(
      await errorCode(
        browser()
          .call()
          .share.submit({
            token: locked.token,
            access: proof,
            values: { title: "Autre lien", files: [key] },
          }),
      ),
    ).toBe("invalid_attachment");
    expect(
      await errorCode(answer(form.token, { title: "Demande", files: [key] })),
    ).toBe("ok");
    expect(await stagedShare(key)).toEqual({
      stagedShareId: null,
      stagedUntil: null,
    });
    const written = await sql<{ title: string; files: string[] }>`
      select title, files from ${sql.table(physical)} where title = 'Demande'
    `.execute(db);
    expect(written.rows).toEqual([{ title: "Demande", files: [key] }]);
    // Claimed: the same file cannot ride a second answer.
    expect(
      await errorCode(answer(form.token, { title: "Encore", files: [key] })),
    ).toBe("invalid_attachment");
  });

  it("leaves the files of an answer that fails waiting", async () => {
    const key = await staged(form.token);
    await expect(
      withAudit(db, { userId: owner, source: "web" }, async (tx) => {
        await claimStagedAttachments(tx, form.id, [key]);
        throw new Error("the row could not be written");
      }),
    ).rejects.toThrow("the row could not be written");
    expect((await stagedShare(key))?.stagedShareId).toBe(form.id);
  });

  it("refuses a file past its deadline, then purges it with its bytes", async () => {
    const late = await staged(form.token);
    const fresh = await staged(form.token);
    await db
      .updateTable("attachments")
      .set({ stagedUntil: sql<Date>`now() - interval '2 hours'` })
      .where("key", "=", late)
      .execute();
    expect(
      await errorCode(answer(form.token, { title: "Tard", files: [late] })),
    ).toBe("invalid_attachment");
    const before = await store.open(late);
    expect(before).toBeDefined();
    before?.body.destroy();
    const failures: unknown[] = [];
    expect(
      await purgeStagedAttachments(db, store, (error) => failures.push(error)),
    ).toBe(1);
    expect(failures).toEqual([]);
    expect(await stagedShare(late)).toBeUndefined();
    expect(await store.open(late)).toBeUndefined();
    // A file still within its deadline stays.
    expect((await stagedShare(fresh))?.stagedShareId).toBe(form.id);
  });
});
