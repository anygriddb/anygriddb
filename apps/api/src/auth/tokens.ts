import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import type { SessionUser } from "./session.js";
import { AppError, type InstanceSettings } from "@anygriddb/core";
import { readGateSettings } from "../settings.js";

const API_TOKEN = /^ag_[A-Za-z0-9_-]{43,128}$/;
/** A token's lifetime when its owner names none, within the policy's. */
export const DEFAULT_TOKEN_DAYS = 30;

/**
 * The days a new token lives (ADR 0043): what its owner asks, up to the
 * instance's longest.
 */
export function tokenDays(
  requested: number | undefined,
  policy: Pick<InstanceSettings, "tokenMaxDays">,
): number {
  if (requested !== undefined && requested > policy.tokenMaxDays) {
    throw new AppError("token_lifetime_too_long", String(policy.tokenMaxDays));
  }
  return requested ?? Math.min(DEFAULT_TOKEN_DAYS, policy.tokenMaxDays);
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type TokenScope = {
  tokenId: string;
  /** Bases the token may reach; null means all of its owner's bases. */
  baseIds: string[] | null;
  readOnly: boolean;
};

/** Resolves a bearer token to its owner and scope. Refreshes `last_used_at` at most once a minute. */
export async function findApiToken(
  db: Database,
  header: string | undefined,
): Promise<{ user: SessionUser; scope: TokenScope } | null> {
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!API_TOKEN.test(token)) {
    return null;
  }
  // A shorter policy holds for tokens made before it, too; tokens kept
  // to administrators leave the others' stopped (ADR 0044).
  const { tokenMaxDays, apiTokens } = await readGateSettings(db);
  const oldest = new Date(Date.now() - tokenMaxDays * 86_400_000);
  const row = await db
    .selectFrom("apiTokens as k")
    .innerJoin("users as u", "u.id", "k.userId")
    .select([
      "u.id",
      "u.email",
      "u.displayName",
      "u.isAdmin",
      "u.isSupport",
      "k.id as tokenId",
      "k.baseIds",
      "k.readOnly",
      "k.lastUsedAt",
    ])
    .where("k.tokenHash", "=", hashApiToken(token))
    .where("k.expiresAt", ">", new Date())
    .where("k.createdAt", ">", oldest)
    .$if(apiTokens === "admins", (query) => query.where("u.isAdmin", "=", true))
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db
      .updateTable("apiTokens")
      .set({ lastUsedAt: new Date() })
      .where("id", "=", row.tokenId)
      .execute();
    // A script at work keeps its owner's account active (ADR 0044).
    await db
      .updateTable("users")
      .set({ activeAt: new Date(), inactivityWarnedAt: null })
      .where("id", "=", row.id)
      .execute();
  }
  return {
    user: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      isSupport: row.isSupport,
    },
    scope: {
      tokenId: row.tokenId,
      baseIds: Array.isArray(row.baseIds) ? row.baseIds : null,
      readOnly: row.readOnly,
    },
  };
}

export async function findApiTokenUser(
  db: Database,
  header: string | undefined,
): Promise<SessionUser | null> {
  return (await findApiToken(db, header))?.user ?? null;
}

export async function createApiToken(
  db: Database,
  userId: string,
  name: string,
  scope: { baseIds?: string[]; readOnly?: boolean; days?: number } = {},
): Promise<{ id: string; token: string; expiresAt: string }> {
  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(
    Date.now() + (scope.days ?? DEFAULT_TOKEN_DAYS) * 86_400_000,
  );
  const inserted = await db
    .insertInto("apiTokens")
    .values({
      userId,
      name,
      tokenHash: hashApiToken(token),
      expiresAt,
      baseIds: scope.baseIds && scope.baseIds.length > 0 ? scope.baseIds : null,
      readOnly: scope.readOnly === true,
    })
    .returning("id")
    .executeTakeFirst();
  const id = inserted?.id;
  if (!id) {
    throw new AppError("no_row");
  }
  return { id, token, expiresAt: expiresAt.toISOString() };
}

/** A person's tokens, each with the day it stops working under today's policy. */
export async function listApiTokens(db: Database, userId: string) {
  const { tokenMaxDays } = await readGateSettings(db);
  const rows = await db
    .selectFrom("apiTokens")
    .select([
      "id",
      "name",
      "createdAt",
      "expiresAt",
      "baseIds",
      "readOnly",
      "lastUsedAt",
    ])
    .where("userId", "=", userId)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    expiresAt: new Date(
      Math.min(
        row.expiresAt.getTime(),
        row.createdAt.getTime() + tokenMaxDays * 86_400_000,
      ),
    ).toISOString(),
    baseIds: Array.isArray(row.baseIds) ? row.baseIds : null,
    readOnly: row.readOnly,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeApiToken(
  db: Database,
  userId: string,
  tokenId: string,
): Promise<void> {
  const deleted = await db
    .deleteFrom("apiTokens")
    .where("id", "=", tokenId)
    .where("userId", "=", userId)
    .returning("id")
    .execute();
  if (deleted.length === 0) {
    throw new AppError("no_row");
  }
}
