/**
 * A public link that names the sites allowed to frame it (ADR 0067),
 * against a real database.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { insertBase, insertTable } from "./schema-ops.js";
import {
  createShare,
  listShares,
  revokeShare,
  shareEmbedOriginsForToken,
} from "./sharing.js";

const suffix = randomBytes(6).toString("hex");

describe("a public link embedded in a site", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let viewId = "";

  const share = (embedOrigins?: string[], expiresAt?: Date) =>
    createShare(db, {
      viewId,
      createdBy: owner,
      allowCopy: false,
      embedOrigins,
      expiresAt,
    });

  beforeAll(async () => {
    const created = await createTestDatabase("share_embed");
    db = created.db;
    close = created.close;
    const person = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    owner = person.id;
    const baseId = (await insertBase(db, owner, { name: "Site" })).id;
    const table = await insertTable(db, owner, {
      baseId,
      name: "Sign-ups",
      columns: [{ name: "name", label: "Name", fieldType: "text" }],
    });
    viewId = (
      await db
        .selectFrom("views")
        .select("id")
        .where("tableId", "=", table.id)
        .executeTakeFirstOrThrow()
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("keeps the sites of a link, once each, and gives them for its page", async () => {
    const link = await share([
      "https://portal.example.org/",
      "https://wiki.example.org:8443",
      "https://portal.example.org",
    ]);
    const sites = [
      "https://portal.example.org",
      "https://wiki.example.org:8443",
    ];
    expect(await shareEmbedOriginsForToken(db, link.token)).toEqual(sites);
    expect(
      (await listShares(db, viewId)).find((item) => item.id === link.id)
        ?.embedOrigins,
    ).toEqual(sites);
  });

  it("frames nowhere a link that names no site, is revoked, expired, or unknown", async () => {
    const plain = await share();
    expect(await shareEmbedOriginsForToken(db, plain.token)).toBeNull();
    expect(
      await shareEmbedOriginsForToken(db, (await share([])).token),
    ).toBeNull();

    const revoked = await share(["https://portal.example.org"]);
    await revokeShare(db, revoked.id);
    expect(await shareEmbedOriginsForToken(db, revoked.token)).toBeNull();

    const expired = await share(
      ["https://portal.example.org"],
      new Date(Date.now() - 1_000),
    );
    expect(await shareEmbedOriginsForToken(db, expired.token)).toBeNull();

    expect(await shareEmbedOriginsForToken(db, "a".repeat(43))).toBeNull();
    expect(await shareEmbedOriginsForToken(db, "not a token")).toBeNull();
  });

  it("refuses what is not the address of a site over HTTPS", async () => {
    for (const site of [
      "http://portal.example.org",
      "https://*.example.org",
      "*",
      "https://portal.example.org/page",
      "https://user@portal.example.org",
      "portal.example.org",
    ]) {
      await expect(share([site]), site).rejects.toMatchObject({
        code: "invalid_embed_origin",
      });
    }
    const many = Array.from(
      { length: 21 },
      (_, index) => `https://site-${String(index)}.example.org`,
    );
    await expect(share(many)).rejects.toMatchObject({
      code: "invalid_embed_origin",
    });
  });
});
