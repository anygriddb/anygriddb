/**
 * OAuth clients an administrator registers (ADR 0094): name, redirect
 * URIs, a secret shown once. Revoking a client stops new codes; existing
 * api_tokens for that client are deleted with their refresh rows.
 */
import { randomBytes } from "node:crypto";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { hashPassword } from "../auth/argon2.js";
import { recordAuthEvent } from "../auth/auth-events.js";

const HTTPS_OR_LOOPBACK =
  /^(https:\/\/.+|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?)$/i;

/** RFC 6749, 3.1.2: no fragment; and no account named in the address. */
function acceptableRedirect(uri: string): boolean {
  if (uri.length > 2_000 || !HTTPS_OR_LOOPBACK.test(uri)) return false;
  if (uri.includes("#") || !URL.canParse(uri)) return false;
  const url = new URL(uri);
  return url.username === "" && url.password === "";
}

function assertRedirectUris(uris: readonly string[]): string[] {
  const cleaned = [
    ...new Set(uris.map((uri) => uri.trim()).filter((uri) => uri.length > 0)),
  ];
  if (cleaned.length === 0 || cleaned.length > 20) {
    throw new AppError("invalid_input");
  }
  for (const uri of cleaned) {
    if (!acceptableRedirect(uri)) throw new AppError("invalid_input");
  }
  return cleaned;
}

/** Registers a client; returns the secret once. */
export async function registerOauthClient(
  db: Database,
  adminId: string,
  input: { name: string; redirectUris: readonly string[] },
): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) throw new AppError("invalid_input");
  const redirectUris = assertRedirectUris(input.redirectUris);
  const clientId = `agc_${randomBytes(24).toString("base64url")}`;
  const clientSecret = `ags_${randomBytes(32).toString("base64url")}`;
  const secretHash = await hashPassword(clientSecret);
  const row = await db.transaction().execute(async (tx) => {
    const inserted = await tx
      .insertInto("oauthClients")
      .values({
        clientId,
        name,
        secretHash,
        redirectUris: sql<string[]>`array[${sql.join(
          redirectUris.map((uri) => sql`${uri}`),
        )}]::text[]`,
        createdBy: adminId,
      })
      .returning(["id", "clientId"])
      .executeTakeFirstOrThrow();
    await recordAuthEvent(tx, {
      action: "settings_changed",
      userId: adminId,
      detail: "oauth_client",
    });
    return inserted;
  });
  return { id: row.id, clientId: row.clientId, clientSecret };
}

export async function listOauthClients(db: Database) {
  const rows = await db
    .selectFrom("oauthClients")
    .select([
      "id",
      "clientId",
      "name",
      "redirectUris",
      "createdAt",
      "revokedAt",
    ])
    .orderBy("createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    redirectUris: row.redirectUris,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

/** Stops the client and deletes every token it was granted. */
export async function revokeOauthClient(
  db: Database,
  adminId: string,
  clientRowId: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const client = await tx
      .selectFrom("oauthClients")
      .select(["id", "revokedAt"])
      .where("id", "=", clientRowId)
      .executeTakeFirst();
    if (!client) throw new AppError("no_row");
    if (!client.revokedAt) {
      await tx
        .updateTable("oauthClients")
        .set({ revokedAt: new Date() })
        .where("id", "=", client.id)
        .execute();
    }
    await tx
      .deleteFrom("apiTokens")
      .where("oauthClientId", "=", client.id)
      .execute();
    await recordAuthEvent(tx, {
      action: "settings_changed",
      userId: adminId,
      detail: "oauth_client_revoked",
    });
  });
}

/** A live client's public name for the consent page. */
export async function previewOauthClient(
  db: Database,
  clientId: string,
): Promise<{ name: string; redirectUris: string[] } | null> {
  const client = await findLiveOauthClient(db, clientId);
  if (!client) return null;
  return { name: client.name, redirectUris: client.redirectUris };
}

/** A live client by its public client_id, or null. */
export async function findLiveOauthClient(
  db: Database,
  clientId: string,
): Promise<{
  id: string;
  clientId: string;
  name: string;
  secretHash: string;
  redirectUris: string[];
} | null> {
  const row = await db
    .selectFrom("oauthClients")
    .select([
      "id",
      "clientId",
      "name",
      "secretHash",
      "redirectUris",
      "revokedAt",
    ])
    .where("clientId", "=", clientId)
    .executeTakeFirst();
  if (!row || row.revokedAt) return null;
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    secretHash: row.secretHash,
    redirectUris: row.redirectUris,
  };
}
