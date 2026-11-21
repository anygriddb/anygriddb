/**
 * A request that names a token answers for that token, against a real
 * database: a browser's session never stands in for one that stopped.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { requestActor } from "./access.js";
import { createSession } from "./session.js";
import { createApiToken, namesApiToken, revokeApiToken } from "./tokens.js";

const suffix = randomBytes(6).toString("hex");

describe("a token beside a session", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let userId = "";
  let cookie = "";

  beforeAll(async () => {
    const created = await createTestDatabase("token_or_session");
    db = created.db;
    close = created.close;
    userId = (
      await db
        .insertInto("users")
        .values({ email: `ada-${suffix}@example.org`, displayName: "Ada" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    cookie = (await createSession(db, userId)).token;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("acts for the token it names, in the token's scope", async () => {
    const { token } = await createApiToken(db, userId, "Reader", {
      readOnly: true,
      days: 1,
    });
    const actor = await requestActor(
      db,
      { authorization: `Bearer ${token}` },
      cookie,
    );
    expect(actor?.scope?.readOnly).toBe(true);
  });

  it("refuses a token that stopped, whatever session is beside it", async () => {
    const made = await createApiToken(db, userId, "Stopped", { days: 1 });
    await revokeApiToken(db, userId, made.id);
    for (const named of [made.token, "ag_unknown", "not-a-token"]) {
      expect(
        await requestActor(db, { authorization: `Bearer ${named}` }, cookie),
      ).toBeNull();
    }
  });

  it("keeps the session under another scheme, as a proxy's sign-in sends", async () => {
    const actor = await requestActor(
      db,
      { authorization: "Basic dXNlcjpwYXNz" },
      cookie,
    );
    expect(actor?.user.id).toBe(userId);
    expect(actor?.scope).toBeUndefined();
    expect(namesApiToken("Basic dXNlcjpwYXNz")).toBe(false);
    expect(namesApiToken(undefined)).toBe(false);
    expect(namesApiToken("Bearer x")).toBe(true);
  });

  it("keeps the session with no header at all", async () => {
    expect((await requestActor(db, {}, cookie))?.user.id).toBe(userId);
  });
});
