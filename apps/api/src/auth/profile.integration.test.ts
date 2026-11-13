/**
 * A person renames themselves; the sign-in trail says so without the name,
 * and an identity provider that provisions the account keeps it.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  errorCode,
  signUpProved,
} from "../trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("renaming one's own account", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
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

  beforeAll(async () => {
    const created = await createTestDatabase("profile");
    db = created.db;
    close = created.close;
    await browser()
      .call()
      .auth.signup({
        email: `admin-${suffix}@example.org`,
        displayName: "Admin",
        password: PASSWORD,
      });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("renames the person, and the trail names what changed", async () => {
    const dana = browser();
    const id = await signUpProved(dana, db, {
      email: `dana-${suffix}@example.org`,
      displayName: "Dnaa",
      password: PASSWORD,
    });
    expect((await dana.call().session.current())?.nameManaged).toBe(false);
    await dana.call().auth.rename({ displayName: "  Dana Example " });
    expect((await dana.call().session.current())?.displayName).toBe(
      "Dana Example",
    );
    const trail = await db
      .selectFrom("authEvents")
      .select(["actorId", "detail"])
      .where("userId", "=", id)
      .where("action", "=", "account_updated")
      .execute();
    expect(trail).toEqual([{ actorId: id, detail: "display_name" }]);
    // The same name again changes nothing and writes nothing.
    await dana.call().auth.rename({ displayName: "Dana Example" });
    expect(
      await db
        .selectFrom("authEvents")
        .select("id")
        .where("userId", "=", id)
        .where("action", "=", "account_updated")
        .execute(),
    ).toHaveLength(1);
  });

  it("refuses an empty name, and an account a provider keeps", async () => {
    const eve = browser();
    const id = await signUpProved(eve, db, {
      email: `eve-${suffix}@example.org`,
      displayName: "Eve",
      password: PASSWORD,
    });
    expect(await errorCode(eve.call().auth.rename({ displayName: "  " }))).toBe(
      "BAD_REQUEST",
    );
    await db
      .updateTable("users")
      .set({ scimUserName: `eve-${suffix}` })
      .where("id", "=", id)
      .execute();
    expect((await eve.call().session.current())?.nameManaged).toBe(true);
    expect(
      await errorCode(eve.call().auth.rename({ displayName: "Mallory" })),
    ).toBe("invalid_account");
    expect((await eve.call().session.current())?.displayName).toBe("Eve");
  });
});
