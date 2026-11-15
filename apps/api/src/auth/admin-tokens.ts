/**
 * The tokens of the administration API (ADR 0086). An administrator makes
 * one, with the proof Administration asks for a change, for the scopes it
 * names. It shows once, only its SHA-256 is kept, and it works while its
 * maker is an active administrator, for as long as the policy lets a token
 * live. The tokens people hold for their bases (`ag_…`) never open
 * Administration, and these open nothing else.
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError, labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { withAudit } from "../data/audit-context.js";
import { readGateSettings } from "../settings.js";
import { tokenDays } from "./tokens.js";

const ADMIN_TOKEN = /^aga_[A-Za-z0-9_-]{43}$/;

/**
 * What a token may do, each named when it is made:
 * - `accounts`: list the accounts, and make one, which is never an
 *   administrator and has no role on a base;
 * - `invitations`: list the invitations that wait;
 * - `settings`: read the instance's settings, and change the ones an
 *   operator's script has cause to (`API_SETTING_KEYS`).
 */
export const ADMIN_SCOPES = ["accounts", "invitations", "settings"] as const;
export type AdminScope = (typeof ADMIN_SCOPES)[number];

export const createAdminTokenInputSchema = z
  .object({
    name: labelSchema,
    scopes: z
      .array(z.enum(ADMIN_SCOPES))
      .min(1)
      .max(ADMIN_SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length),
    /** How long it lives, within the policy's longest. */
    days: z.int().min(1).max(365).optional(),
  })
  .strict();
export const revokeAdminTokenInputSchema = z.object({ tokenId: z.uuid() });

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The scopes a stored list names, in the order the product names them. */
function scopesOf(value: unknown): AdminScope[] {
  const named: readonly unknown[] = Array.isArray(value) ? value : [];
  return ADMIN_SCOPES.filter((scope) => named.includes(scope));
}

export async function createAdminToken(
  db: Database,
  actorId: string,
  input: z.infer<typeof createAdminTokenInputSchema>,
): Promise<{ id: string; token: string; expiresAt: string }> {
  const days = tokenDays(input.days, await readGateSettings(db));
  const token = `aga_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const row = await withAudit(db, { userId: actorId, source: "web" }, (tx) =>
    tx
      .insertInto("adminTokens")
      .values({
        name: input.name,
        tokenHash: tokenHash(token),
        scopes: scopesOf(input.scopes),
        createdBy: actorId,
        expiresAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow(),
  );
  return { id: row.id, token, expiresAt: expiresAt.toISOString() };
}

/** Every token, whoever made it: any administrator may revoke one. */
export async function listAdminTokens(db: Database) {
  const { tokenMaxDays } = await readGateSettings(db);
  const rows = await db
    .selectFrom("adminTokens as t")
    .innerJoin("users as u", "u.id", "t.createdBy")
    .select([
      "t.id",
      "t.name",
      "t.scopes",
      "t.createdAt",
      "t.expiresAt",
      "t.lastUsedAt",
      "u.displayName as createdBy",
      sql<boolean>`(u.is_admin and u.disabled_at is null)`.as("active"),
    ])
    .orderBy("t.createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: scopesOf(row.scopes),
    createdBy: row.createdBy,
    /** False once its maker is no longer an active administrator. */
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    // A policy made shorter since holds for the tokens made before it.
    expiresAt: new Date(
      Math.min(
        row.expiresAt.getTime(),
        row.createdAt.getTime() + tokenMaxDays * 86_400_000,
      ),
    ).toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeAdminToken(
  db: Database,
  actorId: string,
  tokenId: string,
): Promise<void> {
  const deleted = await withAudit(
    db,
    { userId: actorId, source: "web" },
    (tx) =>
      tx
        .deleteFrom("adminTokens")
        .where("id", "=", tokenId)
        .returning("id")
        .execute(),
  );
  if (deleted.length === 0) throw new AppError("not_found");
}

export type AdminTokenActor = {
  tokenId: string;
  scopes: readonly AdminScope[];
  /** The active administrator who made the token: what it does is theirs. */
  maker: { id: string; displayName: string };
};

/**
 * Who a request to the administration API acts as: the active
 * administrator who made its token. Null for anything else, whatever the
 * reason: no token, another kind of token, one that expired or was
 * revoked, a maker who is no longer an administrator.
 */
export async function adminTokenActor(
  db: Database,
  authorization: string | undefined,
): Promise<AdminTokenActor | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token || !ADMIN_TOKEN.test(token)) return null;
  const { tokenMaxDays } = await readGateSettings(db);
  const row = await db
    .selectFrom("adminTokens as t")
    .innerJoin("users as u", "u.id", "t.createdBy")
    .select(["t.id", "t.scopes", "t.createdBy", "u.displayName"])
    .where("t.tokenHash", "=", tokenHash(token))
    .where("t.expiresAt", ">", new Date())
    .where("t.createdAt", ">", new Date(Date.now() - tokenMaxDays * 86_400_000))
    .where("u.isAdmin", "=", true)
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  // Its last use, at most once a minute.
  await db
    .updateTable("adminTokens")
    .set({ lastUsedAt: new Date() })
    .where("id", "=", row.id)
    .where((eb) =>
      eb.or([
        eb("lastUsedAt", "is", null),
        eb("lastUsedAt", "<", new Date(Date.now() - 60_000)),
      ]),
    )
    .execute();
  return {
    tokenId: row.id,
    scopes: scopesOf(row.scopes),
    maker: { id: row.createdBy, displayName: row.displayName },
  };
}
