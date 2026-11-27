/**
 * The bearer tokens an identity provider provisions with (ADR 0038). An
 * administrator makes one; it shows once, only its SHA-256 is kept, and it
 * works while its maker is an active administrator.
 */
import { isAdminOf } from "../auth/instance-roles.js";
import { randomBytes } from "node:crypto";
import { AppError, labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { hashSecret, liveAccess, tokenEnd } from "../auth/delegated.js";
import { withAudit } from "../data/audit-context.js";
import { readGateSettings } from "../settings.js";

const SCIM_TOKEN = /^agscim_[A-Za-z0-9_-]{43}$/;

export const createScimTokenInputSchema = z.object({ name: labelSchema });
export const revokeScimTokenInputSchema = z.object({ tokenId: z.uuid() });

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
      .insertInto("delegatedAccesses")
      .values({
        kind: "scim_token",
        name,
        secretHash: hashSecret(token),
        authorId: actorId,
        endsAt: expiresAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
  );
  return { id: row.id, token };
}

/** Every token not revoked, whoever made it. */
export async function listScimTokens(db: Database) {
  const rows = await db
    .selectFrom("delegatedAccesses as a")
    .innerJoin("users as u", "u.id", "a.authorId")
    .select([
      "a.id",
      "a.name",
      "a.createdAt",
      "a.endsAt",
      "a.lastUsedAt",
      "u.displayName as createdBy",
      sql<boolean>`(${isAdminOf("u.id")} and u.disabled_at is null)`.as(
        "active",
      ),
    ])
    .where("a.kind", "=", "scim_token")
    .where("a.revokedAt", "is", null)
    .orderBy("a.createdAt", "desc")
    .execute();
  return rows.map(({ endsAt, ...row }) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: tokenEnd(endsAt).toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeScimToken(
  db: Database,
  actorId: string,
  tokenId: string,
): Promise<void> {
  const revoked = await withAudit(
    db,
    { userId: actorId, source: "web" },
    (tx) =>
      tx
        .updateTable("delegatedAccesses")
        .set({ revokedAt: new Date() })
        .where("id", "=", tokenId)
        .where("kind", "=", "scim_token")
        .where("revokedAt", "is", null)
        .returning("id")
        .execute(),
  );
  if (revoked.length === 0) throw new AppError("not_found");
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
    .selectFrom("delegatedAccesses as a")
    .innerJoin("users as u", "u.id", "a.authorId")
    .select(["a.id", "a.authorId"])
    .where("a.kind", "=", "scim_token")
    .where("a.secretHash", "=", hashSecret(token))
    .where(liveAccess)
    .where(isAdminOf("u.id"))
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  // Its last use, at most once a minute.
  await db
    .updateTable("delegatedAccesses")
    .set({ lastUsedAt: new Date() })
    .where("id", "=", row.id)
    .where((eb) =>
      eb.or([
        eb("lastUsedAt", "is", null),
        eb("lastUsedAt", "<", new Date(Date.now() - 60_000)),
      ]),
    )
    .execute();
  return row.authorId;
}
