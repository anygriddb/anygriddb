import { sign, verify, type KeyRing } from "../auth/key-ring.js";
import { createHash, randomBytes } from "node:crypto";
import {
  AppError,
  memberDomainAllowed,
  type Given,
  type Grant,
  normalizeEmbedOrigins,
  type Role,
  roleFor,
  storedEmbedOrigins,
  ceilingOf,
} from "@anygriddb/core";
import type { Database, ShareRow, TableRow, ViewRow } from "@anygriddb/db";
import { sql } from "kysely";
import { hashPassword, verifyPassword } from "../auth/argon2.js";
import { withAudit } from "./audit-context.js";
import { liveBase, liveTable, liveView } from "./live.js";
import {
  bindingsFrom,
  givenColumns,
  givenOf,
  MADE_COLUMNS,
} from "./made-roles.js";
import { readGateSettings } from "../settings.js";

const INVITATION_TTL_MS = ceilingOf("protocol.invitation_ms");
const SHARE_ACCESS_TTL_MS = ceilingOf("protocol.link_unlocked_ms");
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isToken(value: string): boolean {
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
    .leftJoin("madeRoles as m", "m.id", "b.madeRoleId")
    .select([
      "u.id as userId",
      "u.displayName",
      "u.email",
      "b.role",
      "b.scope",
      "b.scopeId",
      "b.groupId",
      ...MADE_COLUMNS,
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
      baseRole: Grant | null;
      tableRole: Grant | null;
      /** Their own override, which the list changes: a key or an id. */
      tableGiven: string | null;
      bindings: ReturnType<typeof bindingsFrom>;
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
      tableGiven: null,
      bindings: [],
    };
    current.bindings = [...current.bindings, ...bindingsFrom([row])];
    current.baseRole = roleFor(current.bindings, "base", table.baseId);
    current.tableRole = roleFor(current.bindings, "table", table.id);
    const own = givenOf(row);
    if (row.scope === "table" && row.groupId === null && own !== null) {
      current.tableGiven = typeof own === "string" ? own : own.id;
    }
    people.set(row.userId, current);
  }
  return [...people.values()].map(
    ({ bindings: _bindings, ...person }) => person,
  );
}

/** Sets or clears (`role` null) a table override for one user. */
export async function setTableRole(
  db: Database,
  actorId: string,
  table: { id: string; baseId: string },
  userId: string,
  role: Given | null,
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
          .values({
            userId,
            ...givenColumns(role),
            scope: "table",
            scopeId: table.id,
          })
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
  input: { baseId: string; email: string; role: Given; invitedBy: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const email = input.email.toLowerCase();
  await withAudit(
    db,
    { userId: input.invitedBy, source: "web" },
    async (tx) => {
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
          ...givenColumns(input.role),
          tokenHash: hashToken(token),
          invitedBy: input.invitedBy,
          expiresAt,
        })
        .execute();
    },
  );
  return { token, expiresAt };
}

export async function listInvitations(db: Database, baseId: string) {
  const rows = await db
    .selectFrom("invitations as i")
    .leftJoin("madeRoles as m", "m.id", "i.madeRoleId")
    .select(["i.id", "i.email", "i.role", "i.expiresAt", ...MADE_COLUMNS])
    .where("i.baseId", "=", baseId)
    .where("i.acceptedAt", "is", null)
    .where("i.expiresAt", ">", new Date())
    .orderBy("i.createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: givenOf(row),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export async function revokeInvitation(
  db: Database,
  actorId: string,
  baseId: string,
  invitationId: string,
): Promise<void> {
  await withAudit(db, { userId: actorId, source: "web" }, (tx) =>
    tx
      .deleteFrom("invitations")
      .where("id", "=", invitationId)
      .where("baseId", "=", baseId)
      .execute(),
  );
}

/**
 * A pending invitation's new link: a fresh token and expiry, so the one
 * sent before stops working. For a live base only.
 */
export async function renewInvitation(
  db: Database,
  actorId: string,
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
  const renewed = await withAudit(
    db,
    { userId: actorId, source: "web" },
    (tx) =>
      tx
        .updateTable("invitations")
        .set({ tokenHash: hashToken(token), expiresAt })
        .where("id", "=", pending.id)
        .where("acceptedAt", "is", null)
        .returning("id")
        .executeTakeFirst(),
  );
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
  role: Role | null;
  madeRoleId: string | null;
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
            madeRoleId: invitation.madeRoleId,
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
  const rows = await db
    .selectFrom("invitations as i")
    .innerJoin("bases as b", "b.id", "i.baseId")
    .leftJoin("users as u", "u.id", "i.invitedBy")
    .leftJoin("madeRoles as m", "m.id", "i.madeRoleId")
    .select([
      "i.id",
      "i.role",
      "i.expiresAt",
      "b.id as baseId",
      "b.name as baseName",
      "u.displayName as invitedBy",
      ...MADE_COLUMNS,
    ])
    .where("i.email", "=", email.toLowerCase())
    .where("i.acceptedAt", "is", null)
    .where("i.expiresAt", ">", new Date())
    .where(liveBase("b"))
    .orderBy("i.createdAt", "desc")
    .execute();
  return rows.map(
    ({ madeId: _id, madeName: _name, madePermissions: _p, ...row }) => ({
      ...row,
      role: givenOf({
        ...row,
        madeId: _id,
        madeName: _name,
        madePermissions: _p,
      }),
    }),
  );
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
  await withAudit(db, { userId: user.id, source: "web" }, (tx) =>
    tx
      .deleteFrom("invitations")
      .where("id", "=", invitation.id)
      .where("acceptedAt", "is", null)
      .execute(),
  );
  return null;
}

export async function invitationPreview(db: Database, token: string) {
  if (!isToken(token)) {
    throw new AppError("invalid_invitation");
  }
  const row = await db
    .selectFrom("invitations as i")
    .innerJoin("bases as b", "b.id", "i.baseId")
    .leftJoin("madeRoles as m", "m.id", "i.madeRoleId")
    .select([
      "i.email",
      "i.role",
      "b.name as baseName",
      "i.expiresAt",
      ...MADE_COLUMNS,
    ])
    .where("i.tokenHash", "=", hashToken(token))
    .where("i.acceptedAt", "is", null)
    .where("i.expiresAt", ">", new Date())
    .where(liveBase("b"))
    .executeTakeFirst();
  if (!row) {
    throw new AppError("invalid_invitation");
  }
  return { email: row.email, role: givenOf(row), baseName: row.baseName };
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
  const passwordHash = input.password
    ? await hashPassword(input.password)
    : null;
  const view = await db
    .selectFrom("views")
    .select("tableId")
    .where("id", "=", input.viewId)
    .executeTakeFirst();
  if (!view) throw new AppError("invalid_view");
  const row = await withAudit(
    db,
    { userId: input.createdBy, tableId: view.tableId, source: "web" },
    (tx) =>
      tx
        .insertInto("shares")
        .values({
          viewId: input.viewId,
          tokenHash: hashToken(token),
          passwordHash,
          allowCopy: input.allowCopy,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt ?? null,
          embedOrigins,
        })
        .returning("id")
        .executeTakeFirst(),
  );
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
  actorId: string,
  shareId: string,
): Promise<void> {
  const share = await db
    .selectFrom("shares as s")
    .leftJoin("views as v", "v.id", "s.viewId")
    .select(["s.viewId", "s.baseId", "v.tableId"])
    .where("s.id", "=", shareId)
    .executeTakeFirst();
  if (!share || (!share.viewId && !share.baseId)) {
    throw new AppError("no_row");
  }
  const row = await withAudit(
    db,
    { userId: actorId, tableId: share.tableId ?? undefined, source: "web" },
    (tx) =>
      tx
        .updateTable("shares")
        .set({ revokedAt: new Date() })
        .where("id", "=", shareId)
        .returning("id")
        .executeTakeFirst(),
  );
  if (!row) {
    throw new AppError("no_row");
  }
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

/** What a link shows: a view, or a whole base. */
export async function shareTarget(
  db: Database,
  shareId: string,
): Promise<{ viewId: string } | { baseId: string }> {
  const row = await db
    .selectFrom("shares")
    .select(["viewId", "baseId"])
    .where("id", "=", shareId)
    .executeTakeFirst();
  if (row?.viewId) return { viewId: row.viewId };
  if (row?.baseId) return { baseId: row.baseId };
  throw new AppError("no_row");
}

/**
 * A link to a whole base, read-only (ROADMAP row 93): what its creator
 * may read of each of its tables, with the password, expiry, and lock of
 * a view's link. It writes nothing, so it lets nothing be copied in or
 * framed.
 */
export async function createBaseShare(
  db: Database,
  input: {
    baseId: string;
    createdBy: string;
    password?: string;
    expiresAt?: Date;
  },
): Promise<{ id: string; token: string }> {
  const { publicLinks } = await readGateSettings(db);
  if (publicLinks === "off") throw new AppError("public_links_disabled");
  if (publicLinks === "password" && !input.password) {
    throw new AppError("share_password_required");
  }
  const token = newToken();
  const passwordHash = input.password
    ? await hashPassword(input.password)
    : null;
  const row = await withAudit(
    db,
    { userId: input.createdBy, source: "web" },
    (tx) =>
      tx
        .insertInto("shares")
        .values({
          baseId: input.baseId,
          tokenHash: hashToken(token),
          passwordHash,
          allowCopy: false,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt ?? null,
          embedOrigins: null,
        })
        .returning("id")
        .executeTakeFirst(),
  );
  if (!row) {
    throw new AppError("no_row");
  }
  return { id: row.id, token };
}

/** A base's links, newest first, revoked ones too. */
export async function listBaseShares(db: Database, baseId: string) {
  const rows = await db
    .selectFrom("shares as s")
    .innerJoin("users as u", "u.id", "s.createdBy")
    .select([
      "s.id",
      "s.createdAt",
      "s.expiresAt",
      "s.revokedAt",
      "s.passwordHash",
      "u.displayName as createdBy",
    ])
    .where("s.baseId", "=", baseId)
    .orderBy("s.createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revoked: row.revokedAt !== null,
    protected: row.passwordHash !== null,
    createdBy: row.createdBy,
  }));
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

function verifyShareAccess(
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

type ResolvedShare = {
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
  if (!share?.viewId) return undefined;
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
  return { ...row, ...(await unlockShare(db, key, row.share, input)) };
}

/**
 * Whether a link opens for this visit: at once without a password; with
 * one, for its access proof or the right password, which issues a proof.
 * Wrong passwords count toward its lock.
 */
async function unlockShare(
  db: Database,
  key: KeyRing,
  share: ShareRow,
  input: { password?: string; access?: string },
): Promise<{ access: string | null; locked: boolean }> {
  if (!share.passwordHash) return { access: null, locked: false };
  // Someone who already gave the password keeps reading: the lock stops
  // guesses, not the people the link was sent to.
  if (verifyShareAccess(key, share.id, input.access)) {
    return { access: input.access ?? null, locked: false };
  }
  if (share.passwordLockedUntil && share.passwordLockedUntil > new Date()) {
    throw new AppError("share_locked");
  }
  if (!input.password) return { access: null, locked: true };
  if (await verifyPassword(share.passwordHash, input.password)) {
    if (share.passwordFailures > 0 || share.passwordLockedUntil) {
      await db
        .updateTable("shares")
        .set({ passwordFailures: 0, passwordLockedUntil: null })
        .where("id", "=", share.id)
        .execute();
    }
    return { access: issueShareAccess(key, share.id), locked: false };
  }
  if (await countSharePasswordFailure(db, share.id)) {
    throw new AppError("share_locked");
  }
  return { access: null, locked: true };
}

/**
 * A live link to a whole base, by token, and the base it shows. It stops
 * while its base is in the trash, as a view's link does.
 */
export async function resolveBaseShare(
  db: Database,
  key: KeyRing,
  input: { token: string; password?: string; access?: string },
): Promise<{
  share: ShareRow;
  base: { id: string; name: string };
  access: string | null;
  locked: boolean;
}> {
  if (!isToken(input.token)) throw new AppError("unknown_share");
  const share = await db
    .selectFrom("shares")
    .selectAll()
    .where("tokenHash", "=", hashToken(input.token))
    .executeTakeFirst();
  const base = share?.baseId
    ? await db
        .selectFrom("bases")
        .select(["id", "name"])
        .where("id", "=", share.baseId)
        .where(liveBase())
        .executeTakeFirst()
    : undefined;
  const { publicLinks } = await readGateSettings(db);
  if (
    !share ||
    !base ||
    share.revokedAt ||
    (share.expiresAt && share.expiresAt < new Date()) ||
    publicLinks === "off" ||
    (publicLinks === "password" && !share.passwordHash)
  ) {
    throw new AppError("unknown_share");
  }
  return { share, base, ...(await unlockShare(db, key, share, input)) };
}

const SHARE_PASSWORD_ATTEMPTS = ceilingOf("link.password_attempts");
const SHARE_LOCK_MINUTES = ceilingOf("link.lock_minutes");

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
