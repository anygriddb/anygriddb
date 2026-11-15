/**
 * A thread of comments resolved and opened again, through the API: by
 * anyone who may comment on its row, said with who did it, opened again
 * by a reply; and refused to whoever may only read, to a member whose
 * rule keeps the row from them, of a reply, and of a deleted comment.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { resolveComment } from "../data/comments.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("a thread of comments, resolved and opened again", () => {
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
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const commenter = browser();
  const viewer = browser();
  const stranger = browser();
  let tableId = "";
  let open = "";
  let kept = "";
  let thread = "";
  let reply = "";

  const read = async (rowId: string) =>
    (await owner.call().rows.comments({ tableId, rowId })).comments;

  beforeAll(async () => {
    const created = await createTestDatabase("comment_resolve");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    const baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "ref", label: "Ref", fieldType: "text" }],
      })
    ).id;
    open = (
      await owner.call().rows.insert({ tableId, values: { ref: "open" } })
    ).id;
    kept = (
      await owner.call().rows.insert({ tableId, values: { ref: "kept" } })
    ).id;
    const accounts = [
      [commenter, "commenter", "Cam Commenter"],
      [viewer, "viewer", "Vic Viewer"],
    ] as const;
    for (const [page, role, displayName] of accounts) {
      const email = `${role}-${suffix}@example.org`;
      const userId = await signUpProved(page, db, {
        email,
        displayName,
        password: PASSWORD,
      });
      await owner.call().catalog.grant({ baseId, email, role });
      if (role === "commenter") {
        // The commenter reads the open row, and not the one kept from them.
        await owner.call().catalog.setTableAcl({
          tableId,
          userId,
          rowFilter: {
            conjunction: "and",
            conditions: [{ column: "ref", op: "is", value: "open" }],
          },
          columns: [],
        });
      }
    }
    await signUpProved(stranger, db, {
      email: `stranger-${suffix}@example.org`,
      displayName: "Sam Stranger",
      password: PASSWORD,
    });
    thread = (
      await owner
        .call()
        .rows.addComment({ tableId, rowId: open, body: "Check the label" })
    ).id;
    reply = (
      await commenter.call().rows.addComment({
        tableId,
        rowId: open,
        body: "Done",
        parentId: thread,
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("is resolved by anyone who may comment, and says who did", async () => {
    expect((await read(open))[0]).toMatchObject({
      id: thread,
      resolvedAt: null,
      resolvedByName: null,
    });
    await commenter
      .call()
      .rows.resolveComment({ commentId: thread, resolved: true });
    const [first, second] = await read(open);
    expect(first).toMatchObject({
      id: thread,
      resolvedByName: "Cam Commenter",
    });
    expect(Date.parse(first?.resolvedAt ?? "")).toBeGreaterThan(
      Date.now() - 60_000,
    );
    // A reply is of its thread: it carries nothing of its own.
    expect(second).toMatchObject({ id: reply, resolvedAt: null });

    // Resolved again by someone else: the first to do it stays.
    await owner
      .call()
      .rows.resolveComment({ commentId: thread, resolved: true });
    expect((await read(open))[0]).toMatchObject({
      resolvedAt: first?.resolvedAt,
      resolvedByName: "Cam Commenter",
    });
  });

  it("is opened again by hand, or by a reply", async () => {
    await owner
      .call()
      .rows.resolveComment({ commentId: thread, resolved: false });
    expect((await read(open))[0]).toMatchObject({
      resolvedAt: null,
      resolvedByName: null,
    });
    await owner
      .call()
      .rows.resolveComment({ commentId: thread, resolved: true });
    expect((await read(open))[0]?.resolvedAt).not.toBeNull();
    await commenter.call().rows.addComment({
      tableId,
      rowId: open,
      body: "One more thing",
      parentId: thread,
    });
    expect((await read(open))[0]).toMatchObject({
      resolvedAt: null,
      resolvedByName: null,
    });
  });

  it("is refused to whoever may only read, or has no part in the base", async () => {
    expect(
      await errorCode(
        viewer
          .call()
          .rows.resolveComment({ commentId: thread, resolved: true }),
      ),
    ).toBe("access_denied");
    expect(
      await errorCode(
        stranger
          .call()
          .rows.resolveComment({ commentId: thread, resolved: true }),
      ),
    ).not.toBe("ok");
    expect((await read(open))[0]?.resolvedAt).toBeNull();
  });

  it("is refused on a row the member's rule keeps from them", async () => {
    const hidden = (
      await owner
        .call()
        .rows.addComment({ tableId, rowId: kept, body: "Not theirs" })
    ).id;
    expect(
      await errorCode(
        commenter
          .call()
          .rows.resolveComment({ commentId: hidden, resolved: true }),
      ),
    ).not.toBe("ok");
    expect((await read(kept))[0]?.resolvedAt).toBeNull();
  });

  it("is refused of a reply, of a deleted comment, and of none", async () => {
    expect(
      await errorCode(
        owner.call().rows.resolveComment({ commentId: reply, resolved: true }),
      ),
    ).toBe("invalid_comment");
    const gone = (
      await owner
        .call()
        .rows.addComment({ tableId, rowId: open, body: "A mistake" })
    ).id;
    await owner.call().rows.deleteComment({ commentId: gone });
    expect(
      await errorCode(
        owner.call().rows.resolveComment({ commentId: gone, resolved: true }),
      ),
    ).toBe("invalid_comment");
    expect(
      await errorCode(
        owner.call().rows.resolveComment({
          commentId: "11111111-1111-4111-8111-111111111111",
          resolved: true,
        }),
      ),
    ).toBe("no_row");
  });

  it("keeps a thread resolved when the account that resolved it is deleted", async () => {
    await owner
      .call()
      .rows.resolveComment({ commentId: thread, resolved: false });
    const leaving = await db
      .insertInto("users")
      .values({ email: `leaving-${suffix}@example.org`, displayName: "Lee" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await resolveComment(db, {
      commentId: thread,
      userId: leaving.id,
      resolved: true,
    });
    expect((await read(open))[0]?.resolvedByName).toBe("Lee");
    // Who resolved is forgotten with the account; that it was, is not.
    await db.deleteFrom("users").where("id", "=", leaving.id).execute();
    const [first] = await read(open);
    expect(first?.resolvedByName).toBeNull();
    expect(first?.resolvedAt).not.toBeNull();
  });
});
