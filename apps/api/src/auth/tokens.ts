import { isAdminOf, isAuditorOf, isSupportOf } from "./instance-roles.js";
import { randomBytes } from "node:crypto";
import type { Database, DB, Executor, Tx } from "@anygriddb/db";
import type { UpdateQueryBuilder, UpdateResult } from "kysely";
import { withAudit } from "../data/audit-context.js";
import type { SessionUser } from "./session.js";
import {
  AppError,
  type InstanceSettings,
  type Permission,
  ceilingOf,
} from "@anygriddb/core";
import { recordAuthEvent } from "./auth-events.js";
import { readGateSettings } from "../settings.js";
import {
  entrustedOf,
  hashSecret,
  liveAccess,
  permissionsOf,
  sqlArray,
  switchesOf,
  tokenEnd,
  type TokenSwitches,
} from "./delegated.js";

const API_TOKEN = /^ag_[A-Za-z0-9_-]{43,128}$/;
/** A token's lifetime when its owner names none, within the policy's. */
const DEFAULT_TOKEN_DAYS = ceilingOf("protocol.token_days");

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

export type TokenScope = {
  tokenId: string;
  /** Bases the token may reach; null means all of its owner's bases. */
  baseIds: string[] | null;
  /**
   * What it was entrusted of its owner's permissions (ADR 0131, §5): the
   * roles it acts through give no more. Null, all they give.
   */
  entrusted: Permission[] | null;
  /** It writes nothing: what a viewer may, read back from `entrusted`. */
  readOnly: boolean;
  /** When false, create/update stay; delete is refused (ADR 0079). */
  allowDelete: boolean;
};

/** A token's scope from its row. */
function scopeOf(row: {
  tokenId: string;
  baseIds: string[] | null;
  permissions: string[] | null;
}): TokenScope {
  const entrusted = permissionsOf(row.permissions);
  return {
    tokenId: row.tokenId,
    baseIds: Array.isArray(row.baseIds) ? row.baseIds : null,
    entrusted,
    ...switchesOf(entrusted),
  };
}

/** A person's tokens and the applications they let in. */
const PERSON_KINDS = ["api_token", "application"] as const;

/**
 * Whether a request names an API token. It then answers for that token: one
 * that no longer works is refused, whatever session the browser also holds.
 * Another scheme is not ours: a proxy's Basic sign-in travels in this header.
 */
/**
 * Revokes every API token of an account and the applications it let in,
 * and takes the codes it consented to that were not exchanged yet: such a
 * code would make a new token afterwards. In the caller's audited
 * transaction.
 */
export async function dropAccountTokens(
  tx: Tx,
  userId: string,
): Promise<Array<{ id: string }>> {
  await tx
    .deleteFrom("oauthAuthorizationCodes")
    .where("userId", "=", userId)
    .execute();
  return revokeAccesses(tx, (query) => query.where("authorId", "=", userId));
}

export function namesApiToken(header: string | undefined): boolean {
  return header?.startsWith("Bearer ") === true;
}

/**
 * The tokens that act now, joined with their owner: unexpired, younger
 * than the policy's longest, the owner active, and kept to administrators
 * when the instance says so (ADR 0044).
 */
async function liveTokens(db: Database) {
  const { tokenMaxDays, apiTokens } = await readGateSettings(db);
  const oldest = new Date(Date.now() - tokenMaxDays * 86_400_000);
  return db
    .selectFrom("delegatedAccesses as a")
    .innerJoin("users as u", "u.id", "a.authorId")
    .where("a.kind", "in", PERSON_KINDS)
    .where(liveAccess)
    .where("a.createdAt", ">", oldest)
    .$if(apiTokens === "admins", (query) => query.where(isAdminOf("u.id")))
    .where("u.disabledAt", "is", null);
}

/**
 * What a token still gives, for work it started that runs without it (a
 * job, ADR 0131 §5): its scope while it acts, null once it is revoked,
 * ended, or no longer its author's.
 */
export async function liveTokenScope(
  db: Database,
  tokenId: string,
  userId: string,
): Promise<TokenScope | null> {
  const row = await (
    await liveTokens(db)
  )
    .select(["a.id as tokenId", "a.baseIds", "a.permissions"])
    .where("a.id", "=", tokenId)
    .where("a.authorId", "=", userId)
    .executeTakeFirst();
  return row ? scopeOf(row) : null;
}

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
  const row = await (
    await liveTokens(db)
  )
    .select([
      "u.id",
      "u.email",
      "u.displayName",
      isAdminOf("u.id").as("isAdmin"),
      isSupportOf("u.id").as("isSupport"),
      isAuditorOf("u.id").as("isAuditor"),
      "a.id as tokenId",
      "a.baseIds",
      "a.permissions",
      "a.lastUsedAt",
    ])
    .where("a.secretHash", "=", hashSecret(token))
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db
      .updateTable("delegatedAccesses")
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
      isAuditor: row.isAuditor,
      // A token never opens Administration: its parts stay with the session.
      instanceRoles: [],
    },
    scope: scopeOf(row),
  };
}

type NewTokenScope = TokenSwitches & {
  baseIds?: string[];
  days?: number;
  /** When set, the token came from an OAuth grant (ADR 0094). */
  oauthClientId?: string;
  /** Sign-in trail detail; defaults to a Settings token. */
  detail?: string;
};

type NewToken = { id: string; token: string; expiresAt: string };

export async function createApiToken(
  db: Database,
  userId: string,
  name: string,
  scope: NewTokenScope = {},
): Promise<NewToken> {
  return withAudit(db, { userId, source: "web" }, (tx) =>
    insertApiToken(tx, userId, name, scope),
  );
}

/**
 * The token and its line on the sign-in trail, in the caller's audited
 * transaction: an application's grant makes its token with its code.
 */
export async function insertApiToken(
  tx: Executor,
  userId: string,
  name: string,
  scope: NewTokenScope,
): Promise<NewToken> {
  const token = `ag_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(
    Date.now() + (scope.days ?? DEFAULT_TOKEN_DAYS) * 86_400_000,
  );
  const entrusted = entrustedOf(scope);
  const inserted = await tx
    .insertInto("delegatedAccesses")
    .values({
      kind: scope.oauthClientId ? "application" : "api_token",
      authorId: userId,
      name,
      secretHash: hashSecret(token),
      endsAt: expiresAt,
      baseIds:
        scope.baseIds && scope.baseIds.length > 0
          ? sqlArray(scope.baseIds, "uuid")
          : null,
      // Omitted, deleting is allowed (scripts keep deleting).
      permissions: entrusted === null ? null : sqlArray(entrusted, "text"),
      clientId: scope.oauthClientId ?? null,
    })
    .returning("id")
    .executeTakeFirst();
  if (!inserted) throw new AppError("no_row");
  // Who made it, never the token: the sign-in trail's contract.
  await recordAuthEvent(tx, {
    action: "token_created",
    userId,
    detail: scope.detail ?? "self_service_token",
  });
  return { id: inserted.id, token, expiresAt: expiresAt.toISOString() };
}

/** A person's tokens, each with the day it stops working under today's policy. */
export async function listApiTokens(db: Database, userId: string) {
  const { tokenMaxDays } = await readGateSettings(db);
  const rows = await db
    .selectFrom("delegatedAccesses")
    .select([
      "id",
      "name",
      "createdAt",
      "endsAt",
      "baseIds",
      "permissions",
      "lastUsedAt",
    ])
    .where("authorId", "=", userId)
    .where("kind", "in", PERSON_KINDS)
    .where("revokedAt", "is", null)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    expiresAt: new Date(
      Math.min(
        tokenEnd(row.endsAt).getTime(),
        row.createdAt.getTime() + tokenMaxDays * 86_400_000,
      ),
    ).toISOString(),
    baseIds: Array.isArray(row.baseIds) ? row.baseIds : null,
    ...switchesOf(permissionsOf(row.permissions)),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

/**
 * Revokes one API token. The owner or an administrator may ask; the
 * sign-in trail records who, never the token itself.
 */
export async function revokeApiToken(
  db: Database,
  userId: string,
  tokenId: string,
  actor?: { actorId: string; admin: boolean },
): Promise<void> {
  await withAudit(
    db,
    { userId: actor?.actorId ?? userId, source: "web" },
    async (tx) => {
      const revoked = await revokeAccesses(tx, (query) =>
        query.where("id", "=", tokenId).where("authorId", "=", userId),
      );
      if (revoked.length === 0) {
        throw new AppError("no_row");
      }
      await recordAuthEvent(tx, {
        action: "tokens_revoked",
        userId,
        actorId: actor?.actorId ?? userId,
        method: actor?.admin ? "admin" : undefined,
        detail: actor?.admin ? "admin_revoke_user" : "self_service_token",
      });
    },
  );
}

/**
 * Revokes the live tokens of a person a query picks, and the refresh
 * tokens an application renews them with, in the caller's audited
 * transaction. A revoked token stays, and acts on nothing.
 */
export async function revokeAccesses(
  tx: Executor,
  pick: (
    query: UpdateQueryBuilder<
      DB,
      "delegatedAccesses",
      "delegatedAccesses",
      UpdateResult
    >,
  ) => UpdateQueryBuilder<
    DB,
    "delegatedAccesses",
    "delegatedAccesses",
    UpdateResult
  >,
): Promise<Array<{ id: string; authorId: string }>> {
  const revoked = await pick(
    tx
      .updateTable("delegatedAccesses")
      .set({ revokedAt: new Date() })
      .where("kind", "in", PERSON_KINDS)
      .where("revokedAt", "is", null),
  )
    .returning(["id", "authorId"])
    .execute();
  if (revoked.length > 0) {
    await tx
      .updateTable("oauthRefreshTokens")
      .set({ revokedAt: new Date() })
      .where(
        "accessId",
        "in",
        revoked.map((row) => row.id),
      )
      .where("revokedAt", "is", null)
      .execute();
  }
  return revoked;
}
