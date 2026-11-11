/**
 * The bearer tokens an identity provider provisions with (ADR 0038). An
 * administrator makes one; it shows once, only its SHA-256 is kept, and it
 * works while its maker is an active administrator.
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError, labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { withAudit } from "../data/audit-context.js";
import { readGateSettings } from "../settings.js";

const SCIM_TOKEN = /^agscim_[A-Za-z0-9_-]{43}$/;

export const createScimTokenInputSchema = z.object({ name: labelSchema });
export const revokeScimTokenInputSchema = z.object({ tokenId: z.uuid() });

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createScimToken(
  db: Database,
  actorId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const token = `agscim_${randomBytes(32).toString("base64url")}`;
  const { tokenMaxDays } = await readGateSettings(db);
  const expiresAt = new Date(Date.now() + tokenMaxDays * 86_400_000);
  const row = await withAudit(db, { userId: actorId, source: "web" }, (tx) =>
    tx
      .insertInto("scimTokens")
      .values({
        name,
        tokenHash: tokenHash(token),
        createdBy: actorId,
        expiresAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
  );
  return { id: row.id, token };
}

export async function listScimTokens(db: Database) {
  const rows = await db
    .selectFrom("scimTokens as t")
    .innerJoin("users as u", "u.id", "t.createdBy")
    .select([
      "t.id",
      "t.name",
      "t.createdAt",
      "t.expiresAt",
      "t.lastUsedAt",
      "u.displayName as createdBy",
      sql<boolean>`(u.is_admin and u.disabled_at is null)`.as("active"),
    ])
    .orderBy("t.createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeScimToken(
  db: Database,
  actorId: string,
  tokenId: string,
): Promise<void> {
  const deleted = await withAudit(
    db,
    { userId: actorId, source: "web" },
    (tx) =>
      tx
        .deleteFrom("scimTokens")
        .where("id", "=", tokenId)
        .returning("id")
        .execute(),
  );
  if (deleted.length === 0) throw new AppError("not_found");
}

/**
 * Who a provisioning request acts as: the active administrator who made
 * its token. Null for anything else, whatever the reason.
 */
export async function scimActor(
  db: Database,
  authorization: string | undefined,
): Promise<string | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token || !SCIM_TOKEN.test(token)) return null;
  const row = await db
    .selectFrom("scimTokens as t")
    .innerJoin("users as u", "u.id", "t.createdBy")
    .select(["t.id", "t.createdBy"])
    .where("t.tokenHash", "=", tokenHash(token))
    .where("t.expiresAt", ">", new Date())
    .where("u.isAdmin", "=", true)
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  // Its last use, at most once a minute.
  await db
    .updateTable("scimTokens")
    .set({ lastUsedAt: new Date() })
    .where("id", "=", row.id)
    .where((eb) =>
      eb.or([
        eb("lastUsedAt", "is", null),
        eb("lastUsedAt", "<", new Date(Date.now() - 60_000)),
      ]),
    )
    .execute();
  return row.createdBy;
}
