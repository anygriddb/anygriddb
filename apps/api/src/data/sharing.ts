import { sign, verify, type KeyRing } from "../auth/key-ring.js";
import { createHash, randomBytes } from "node:crypto";
import {
  AppError,
  memberDomainAllowed,
  normalizeEmbedOrigins,
  type Role,
  roleFor,
  storedEmbedOrigins,
} from "@anygriddb/core";
import type { Database, ShareRow, TableRow, ViewRow } from "@anygriddb/db";
import { sql } from "kysely";
import { hashPassword, verifyPassword } from "../auth/argon2.js";
import { withAudit } from "./audit-context.js";
import { liveBase, liveTable, liveView } from "./live.js";
import { readGateSettings } from "../settings.js";

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SHARE_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isToken(value: string): boolean {
  return TOKEN.test(value);
}

/* ------------------------------------------------------------------ */
/* Table overrides                                                     */
/* ------------------------------------------------------------------ */

export async function listTableAccess(
  db: Database,
  table: { id: string; baseId: string },
) {
  const rows = await db
    .selectFrom("roleBindings as b")
    .innerJoin("users as u", "u.id", "b.userId")
    .select([
      "u.id as userId",
      "u.displayName",
      "u.email",
      "b.role",
      "b.scope",
      "b.scopeId",
    ])
    .where((eb) =>
      eb.or([
        eb.and([
          eb("b.scope", "=", "base"),
          eb("b.scopeId", "=", table.baseId),
        ]),
        eb.and([eb("b.scope", "=", "table"), eb("b.scopeId", "=", table.id)]),
      ]),
    )
    .execute();
  const people = new Map<
    string,
    {
      userId: string;
      displayName: string;
      email: string;
      baseRole: Role | null;
      tableRole: Role | null;
    }
  >();
  for (const row of rows) {
    const relevant =
      (row.scope === "base" && row.scopeId === table.baseId) ||
      (row.scope === "table" && row.scopeId === table.id);
    if (!relevant) continue;
    const current = people.get(row.userId) ?? {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      baseRole: null,
      tableRole: null,
    };
    if (row.scope === "base")
      current.baseRole = roleFor(
        [{ role: row.role, scope: "base", scopeId: table.baseId }],
        "base",
        table.baseId,
      );
    else current.tableRole = row.role;
    people.set(row.userId, current);
  }
  return [...people.values()];
}

/** Sets or clears (`role` null) a table override for one user. */
export async function setTableRole(
  db: Database,
  actorId: string,
  table: { id: string; baseId: string },
  userId: string,
  role: Role | null,
): Promise<void> {
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!user) {
    throw new AppError("unknown_account");
  }
  await withAudit(
    db,
    { userId: actorId, tableId: table.id, source: "web" },
    async (tx) => {
      await tx
        .deleteFrom("roleBindings")
        .where("userId", "=", userId)
        .where("scope", "=", "table")
        .where("scopeId", "=", table.id)
        .where("groupId", "is", null)
        .execute();
      if (role) {
        await tx
          .insertInto("roleBindings")
          .values({ userId, role, scope: "table", scopeId: table.id })
          .execute();
      }
    },
  );
}

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

export async function createInvitation(
  db: Database,
  input: { baseId: string; email: string; role: Role; invitedBy: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const email = input.email.toLowerCase();
  await db.transaction().execute(async (tx) => {
    // Inviting again replaces the pending invitation: one live link.
    await tx
      .deleteFrom("invitations")
      .where("baseId", "=", input.baseId)
      .where("email", "=", email)
      .where("acceptedAt", "is", null)
      .execute();
    await tx
      .insertInto("invitations")
      .values({
        baseId: input.baseId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: input.invitedBy,
        expiresAt,
      })
      .execute();
  });
  return { token, expiresAt };
}

export async function listInvitations(db: Database, baseId: string) {
  const rows = await db
    .selectFrom("invitations")
    .selectAll()
    .where("baseId", "=", baseId)
    .where("acceptedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .orderBy("createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export async function revokeInvitation(
  db: Database,
  baseId: string,
  invitationId: string,
): Promise<void> {
  await db
    .deleteFrom("invitations")
    .where("id", "=", invitationId)
    .where("baseId", "=", baseId)
    .execute();
}

/**
 * A pending invitation's new link: a fresh token and expiry, so the one
 * sent before stops working. For a live base only.
 */
export async function renewInvitation(
  db: Database,
  invitationId: string,
): Promise<{
  token: string;
  expiresAt: Date;
  email: string;
  baseName: string;
  inviterName: string | null;
}> {
  const pending = await db
    .selectFrom("invitations as i")
    .innerJoin("bases as b", "b.id", "i.baseId")
    .leftJoin("users as u", "u.id", "i.invitedBy")
    .select(["i.id", "i.email", "b.name as baseName", "u.displayName"])
    .where("i.id", "=", invitationId)
    .where("i.acceptedAt", "is", null)
    .where(liveBase("b"))
    .executeTakeFirst();
  if (!pending) throw new AppError("invalid_invitation");
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const renewed = await db
    .updateTable("invitations")
    .set({ tokenHash: hashToken(token), expiresAt })
    .where("id", "=", pending.id)
    .where("acceptedAt", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!renewed) throw new AppError("invalid_invitation");
  return {
    token,
    expiresAt,
    email: pending.email,
    baseName: pending.baseName,
    inviterName: pending.displayName,
  };
}

type PendingInvitation = {
  id: string;
  baseId: string;
  email: string;
  role: Role;
  invitedBy: string;
};

/** Gives the invited account its role: the invitation is spent with it. */
async function joinBase(
  db: Database,
  user: { id: string },
  invitation: PendingInvitation,
): Promise<{ baseId: string }> {
  // Sent before invitations kept to the domains: it no longer opens.
  await assertMemberDomain(db, invitation.email);
  await withAudit(
    db,
    { userId: invitation.invitedBy, source: "invitation" },
    async (tx) => {
      // The invitation is taken first: of two acceptances racing, one wins.
      const taken = await tx
        .updateTable("invitations")
        .set({ acceptedAt: new Date() })
        .where("id", "=", invitation.id)
        .where("acceptedAt", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (!taken) throw new AppError("invalid_invitation");
      // A role a group gives does not count: it goes with the group.
      const existing = await tx
        .selectFrom("roleBindings")
        .select("role")
        .where("userId", "=", user.id)
        .where("scope", "=", "base")
        .where("scopeId", "=", invitation.baseId)
        .where("groupId", "is", null)
        .execute();
      if (existing.length === 0) {
        await tx
          .insertInto("roleBindings")
          .values({
            userId: user.id,
            role: invitation.role,
            scope: "base",
            scopeId: invitation.baseId,
          })
          .execute();
      }
    },
  );
  return { baseId: invitation.baseId };
}

/** Turns a pending invitation into a base role for the signed-in user. */
export async function acceptInvitation(
  db: Database,
  user: { id: string; email: string },
  token: string,
): Promise<{ baseId: string }> {
  if (!isToken(token)) {
    throw new AppError("invalid_invitation");
  }
  const invitation = await db
    .selectFrom("invitations")
    .selectAll()
    .where("tokenHash", "=", hashToken(token))
    .where("acceptedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!invitation) {
    throw new AppError("invalid_invitation");
  }
  if (invitation.email !== user.email.toLowerCase()) {
    throw new AppError("invalid_invitation");
  }
  return joinBase(db, user, invitation);
}

/**
 * The invitations waiting for an account's address. An account's address
 * is proved (ADR 0058), so its holder answers them from the home page,
 * without the link: whoever invites learns nothing until then, not even
 * whether the address has an account.
 */
export async function listInvitationsFor(db: Database, email: string) {
  return db
    .selectFrom("invitations as i")
    .innerJoin("bases as b", "b.id", "i.baseId")
    .leftJoin("users as u", "u.id", "i.invitedBy")
    .select([
      "i.id",
      "i.role",
      "i.expiresAt",
      "b.id as baseId",
      "b.name as baseName",
      "u.displayName as invitedBy",
    ])
    .where("i.email", "=", email.toLowerCase())
    .where("i.acceptedAt", "is", null)
    .where("i.expiresAt", ">", new Date())
    .where(liveBase("b"))
    .orderBy("i.createdAt", "desc")
    .execute();
}

/**
 * The account's answer to an invitation sent to its address: accepted, it
 * gets the role; declined, the invitation is gone. Another address's
 * invitation is not found.
 */
export async function answerInvitation(
  db: Database,
  user: { id: string; email: string },
  invitationId: string,
  accept: boolean,
): Promise<{ baseId: string } | null> {
  const invitation = await db
    .selectFrom("invitations")
    .selectAll()
    .where("id", "=", invitationId)
    .where("email", "=", user.email.toLowerCase())
    .where("acceptedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!invitation) {
    throw new AppError("invalid_invitation");
  }
  if (accept) return joinBase(db, user, invitation);
  await db
    .deleteFrom("invitations")
    .where("id", "=", invitation.id)
    .where("acceptedAt", "is", null)
    .execute();
  return null;
}

export async function invitationPreview(db: Database, token: string) {
  if (!isToken(token)) {
    throw new AppError("invalid_invitation");
  }
  const row = await db
    .selectFrom("invitations as i")
    .innerJoin("bases as b", "b.id", "i.baseId")
    .select(["i.email", "i.role", "b.name as baseName", "i.expiresAt"])
    .where("i.tokenHash", "=", hashToken(token))
    .where("i.acceptedAt", "is", null)
    .where("i.expiresAt", ">", new Date())
    .where(liveBase("b"))
    .executeTakeFirst();
  if (!row) {
    throw new AppError("invalid_invitation");
  }
  return { email: row.email, role: row.role, baseName: row.baseName };
}

/**
 * Owners give roles only to addresses the instance allows (ADR 0044):
 * any, unless invitations keep to the sign-up domains.
 */
export async function assertMemberDomain(
  db: Database,
  email: string,
): Promise<void> {
  if (!memberDomainAllowed(email, await readGateSettings(db))) {
    throw new AppError("invitation_domain_not_allowed");
  }
}

/* ------------------------------------------------------------------ */
/* Public shares                                                       */
/* ------------------------------------------------------------------ */

export async function createShare(
  db: Database,
  input: {
    viewId: string;
    createdBy: string;
    password?: string;
    expiresAt?: Date;
    allowCopy: boolean;
    embedOrigins?: string[] | null;
  },
): Promise<{ id: string; token: string }> {
  const { publicLinks } = await readGateSettings(db);
  if (publicLinks === "off") throw new AppError("public_links_disabled");
  if (publicLinks === "password" && !input.password) {
    throw new AppError("share_password_required");
  }
  const embedOrigins = normalizeEmbedOrigins(input.embedOrigins);
  const token = newToken();
  const row = await db
    .insertInto("shares")
    .values({
      viewId: input.viewId,
      tokenHash: hashToken(token),
      passwordHash: input.password ? await hashPassword(input.password) : null,
      allowCopy: input.allowCopy,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
      embedOrigins,
    })
    .returning("id")
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return { id: row.id, token };
}

export async function listShares(db: Database, viewId: string) {
  const rows = await db
    .selectFrom("shares as s")
    .innerJoin("users as u", "u.id", "s.createdBy")
    .select([
      "s.id",
      "s.createdAt",
      "s.expiresAt",
      "s.revokedAt",
      "s.passwordHash",
      "s.allowCopy",
      "s.embedOrigins",
      "u.displayName as createdBy",
    ])
    .where("s.viewId", "=", viewId)
    .orderBy("s.createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revoked: row.revokedAt !== null,
    protected: row.passwordHash !== null,
    allowCopy: row.allowCopy,
    embedOrigins: storedEmbedOrigins(row.embedOrigins) ?? [],
    createdBy: row.createdBy,
  }));
}

export async function revokeShare(
  db: Database,
  shareId: string,
): Promise<{ viewId: string }> {
  const row = await db
    .updateTable("shares")
    .set({ revokedAt: new Date() })
    .where("id", "=", shareId)
    .returning("viewId")
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return row;
}

/**
 * The sites that may show the share behind this link in a frame (ADR
 * 0067), or null: an unknown, revoked, or expired link is framed nowhere,
 * as a link that names no site.
 */
export async function shareEmbedOriginsForToken(
  db: Database,
  token: string,
): Promise<string[] | null> {
  if (!isToken(token)) return null;
  const row = await db
    .selectFrom("shares")
    .select(["embedOrigins", "revokedAt", "expiresAt"])
    .where("tokenHash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) {
    return null;
  }
  return storedEmbedOrigins(row.embedOrigins);
}

export async function shareViewId(
  db: Database,
  shareId: string,
): Promise<string> {
  const row = await db
    .selectFrom("shares")
    .select("viewId")
    .where("id", "=", shareId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return row.viewId;
}

/** Short-lived proof that the share password was given: `expiry.mac`. */
export function issueShareAccess(
  key: KeyRing,
  shareId: string,
  now = Date.now(),
): string {
  const expiry = now + SHARE_ACCESS_TTL_MS;
  const mac = sign(key, "share-access", `${shareId}.${expiry}`);
  return `${expiry}.${mac.toString("base64url")}`;
}

export function verifyShareAccess(
  key: KeyRing,
  shareId: string,
  access: string | undefined,
  now = Date.now(),
): boolean {
  if (!access) return false;
  const [expiryText, mac] = access.split(".");
  const expiry = Number(expiryText);
  if (!mac || !Number.isFinite(expiry) || expiry < now) return false;
  return verify(
    key,
    "share-access",
    `${shareId}.${expiry}`,
    Buffer.from(mac, "base64url"),
  );
}

export type ResolvedShare = {
  share: ShareRow;
  view: ViewRow;
  table: TableRow;
};

/**
 * A share with its view and table. A share stops working while its view,
 * table, or base is in the trash.
 */
async function findShare(
  db: Database,
  tokenHash: string,
): Promise<ResolvedShare | undefined> {
  const share = await db
    .selectFrom("shares")
    .selectAll()
    .where("tokenHash", "=", tokenHash)
    .executeTakeFirst();
  if (!share) return undefined;
  const view = await db
    .selectFrom("views")
    .selectAll()
    .where("id", "=", share.viewId)
    .where(liveView())
    .executeTakeFirst();
  if (!view) return undefined;
  const table = await db
    .selectFrom("dataTables as t")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .selectAll("t")
    .where("t.id", "=", view.tableId)
    .where(liveTable("t"))
    .where(liveBase("b"))
    .executeTakeFirst();
  return table ? { share, view, table } : undefined;
}

/**
 * Finds a live share by token. A password-protected share needs either the
 * password (checked with Argon2id) or a valid access proof.
 */
export async function resolveShare(
  db: Database,
  key: KeyRing,
  input: { token: string; password?: string; access?: string },
): Promise<ResolvedShare & { access: string | null; locked: boolean }> {
  if (!isToken(input.token)) {
    throw new AppError("unknown_share");
  }
  const row = await findShare(db, hashToken(input.token));
  // Public links off, or only with a password (ADR 0043): the others stop.
  const { publicLinks } = await readGateSettings(db);
  if (
    !row ||
    row.share.revokedAt ||
    (row.share.expiresAt && row.share.expiresAt < new Date()) ||
    row.view.ownerId ||
    publicLinks === "off" ||
    (publicLinks === "password" && !row.share.passwordHash)
  ) {
    throw new AppError("unknown_share");
  }
  if (!row.share.passwordHash) {
    return { ...row, access: null, locked: false };
  }
  // Someone who already gave the password keeps reading: the lock stops
  // guesses, not the people the link was sent to.
  if (verifyShareAccess(key, row.share.id, input.access)) {
    return { ...row, access: input.access ?? null, locked: false };
  }
  if (
    row.share.passwordLockedUntil &&
    row.share.passwordLockedUntil > new Date()
  ) {
    throw new AppError("share_locked");
  }
  if (!input.password) {
    return { ...row, access: null, locked: true };
  }
  if (await verifyPassword(row.share.passwordHash, input.password)) {
    if (row.share.passwordFailures > 0 || row.share.passwordLockedUntil) {
      await db
        .updateTable("shares")
        .set({ passwordFailures: 0, passwordLockedUntil: null })
        .where("id", "=", row.share.id)
        .execute();
    }
    return {
      ...row,
      access: issueShareAccess(key, row.share.id),
      locked: false,
    };
  }
  if (await countSharePasswordFailure(db, row.share.id)) {
    throw new AppError("share_locked");
  }
  return { ...row, access: null, locked: true };
}

const SHARE_PASSWORD_ATTEMPTS = 10;
const SHARE_LOCK_MINUTES = 15;

/**
 * Counts a wrong password in one statement, so guesses sent at the same
 * time each count. The last one allowed locks the link and starts the
 * count again; true when it did.
 */
async function countSharePasswordFailure(
  db: Database,
  shareId: string,
): Promise<boolean> {
  const last = sql<boolean>`password_failures + 1 >= ${SHARE_PASSWORD_ATTEMPTS}`;
  const counted = await db
    .updateTable("shares")
    .set({
      passwordFailures: sql<number>`case when ${last} then 0 else password_failures + 1 end`,
      passwordLockedUntil: sql<Date | null>`case when ${last} then now() + make_interval(mins => ${SHARE_LOCK_MINUTES}) else null end`,
    })
    .where("id", "=", shareId)
    .returning("passwordLockedUntil")
    .executeTakeFirst();
  return Boolean(counted?.passwordLockedUntil);
}
