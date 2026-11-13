import { purgeRecordOf } from "./data/audit-purge.js";
import { exportRecordOf } from "./data/export-audit.js";
import {
  ADMIN_LOCK_MINUTES,
  AppError,
  emailDomainAllowed,
  labelSchema,
  lockState,
  memberDomainAllowed,
  parseAdminEmails,
  ROLES,
  signupAllowed,
} from "@anygriddb/core";
import type { AuditAction, Database } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import { z } from "zod";
import type { Bus } from "./realtime/bus.js";
import { factorMethods } from "./auth/access.js";
import { listApiTokens } from "./auth/tokens.js";
import { withAudit } from "./data/audit-context.js";
import { ERASED_USER_ID } from "./data/erasure.js";
import { liveBase } from "./data/live.js";
import { bindRole } from "./data/members.js";
import { assertMemberDomain } from "./data/sharing.js";
import { recordAuthEvent } from "./auth/auth-events.js";
import { BUILD } from "./build-info.js";
import { isUniqueViolation } from "./data/schema-ops.js";
import type { FileStore } from "./files/index.js";
import { readSettings } from "./settings.js";

/**
 * An account an administrator creates (ROADMAP #67): who, whether they
 * administer the instance, and the bases they reach from the start, with
 * their role on each, one base at most once.
 */
export const createAccountInputSchema = z
  .object({
    email: z.email().max(254),
    displayName: labelSchema,
    admin: z.boolean().default(false),
    memberships: z
      .array(z.object({ baseId: z.uuid(), role: z.enum(ROLES) }).strict())
      .max(20)
      .default([])
      .refine(
        (rows) => new Set(rows.map((row) => row.baseId)).size === rows.length,
        "A base appears once",
      ),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Settings and sign-up                                                */
/* ------------------------------------------------------------------ */

/**
 * Decides whether an email may create an account, and whether it starts
 * as an administrator: the first account, or one listed in ADMIN_EMAILS.
 */
/** Whether the instance has an account: the first sets it up (ADR 0058). */
export async function hasAccounts(db: Database): Promise<boolean> {
  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("id", "<>", ERASED_USER_ID)
    .limit(1)
    .executeTakeFirst();
  return existing !== undefined;
}

export async function signupDecision(
  db: Database,
  email: string,
  adminEmails: string | undefined,
): Promise<{
  allowed: boolean;
  isAdmin: boolean;
  /** The instance has no account yet: this one sets it up, at once. */
  firstAccount: boolean;
  /** Why not: the sign-up policy, or an address outside the domains. */
  refusal?: "signup_closed" | "signup_domain_not_allowed";
}> {
  const firstAccount = !(await hasAccounts(db));
  const invitation = await db
    .selectFrom("invitations")
    .select("id")
    .where("email", "=", email)
    .where("acceptedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  const settings = await readSettings(db);
  const listedAdmin = parseAdminEmails(adminEmails).has(email);
  const isAdmin = firstAccount || listedAdmin;
  // An invitation counts only while invitations may reach this address.
  const invited = Boolean(invitation) && memberDomainAllowed(email, settings);
  if (!signupAllowed(settings.signup, { firstAccount, invited })) {
    return { allowed: false, isAdmin, firstAccount, refusal: "signup_closed" };
  }
  // The domains hold for anyone who comes on their own: an owner's
  // invitation, the operator's ADMIN_EMAILS, and the first account pass.
  if (
    !firstAccount &&
    !listedAdmin &&
    !invited &&
    !emailDomainAllowed(email, settings.signupDomains)
  ) {
    return {
      allowed: false,
      isAdmin,
      firstAccount,
      refusal: "signup_domain_not_allowed",
    };
  }
  return { allowed: true, isAdmin, firstAccount };
}

/** Grants admin to existing accounts listed in ADMIN_EMAILS, at start-up. */
export async function promoteListedAdmins(
  db: Database,
  adminEmails: string | undefined,
): Promise<void> {
  const listed = [...parseAdminEmails(adminEmails)];
  if (listed.length === 0) return;
  await db
    .updateTable("users")
    .set({ isAdmin: true })
    .where("email", "in", listed)
    .where("isAdmin", "=", false)
    .execute();
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

/** What the accounts list filters and sorts by (ROADMAP #18). */
export const listUsersInputSchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "disabled", "locked"]).optional(),
  admin: z.boolean().optional(),
  /** Whether the account has a second factor of AnyGridDB's own. */
  mfa: z.boolean().optional(),
  origin: z.enum(["local", "sso", "scim"]).optional(),
  sort: z.enum(["name", "email", "created", "lastSeen"]).default("created"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  offset: z.int().min(0).max(1_000_000).default(0),
  limit: z.int().min(1).max(100).default(50),
});

/**
 * Accounts, filtered and sorted in SQL, a page at a time with the total.
 * A lock counts while it runs: by the policy's duration, or until an
 * administrator lifts it when the policy keeps it.
 */
export async function listUsers(
  db: Database,
  input: z.input<typeof listUsersInputSchema>,
) {
  const query = listUsersInputSchema.parse(input);
  const policy = await readSettings(db);
  const pattern = query.search
    ? `%${query.search.replace(/[%_\\]/g, "\\$&")}%`
    : undefined;
  const hasFactor = sqlTag<boolean>`(exists (select 1 from totp_secrets t where t.user_id = u.id and t.confirmed_at is not null) or exists (select 1 from webauthn_credentials w where w.user_id = u.id))`;
  const signOn = sqlTag<boolean>`exists (select 1 from sso_identities i where i.user_id = u.id)`;
  // Kept on the account: sessions go once expired, the trail in time.
  const lastSeen = sqlTag<Date | null>`u.last_sign_in_at`;
  // As `lockState`: a lock runs for the policy's minutes; with none, it
  // waits for an administrator, except an administrator's own.
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000);
  const matching = () =>
    db
      .selectFrom("users as u")
      .where("u.id", "<>", ERASED_USER_ID)
      .$if(pattern !== undefined, (q) =>
        q.where((eb) =>
          eb.or([
            eb("u.email", "ilike", pattern ?? ""),
            eb("u.displayName", "ilike", pattern ?? ""),
          ]),
        ),
      )
      .$if(query.status === "active", (q) =>
        q.where("u.disabledAt", "is", null),
      )
      .$if(query.status === "disabled", (q) =>
        q.where("u.disabledAt", "is not", null),
      )
      .$if(query.status === "locked", (q) =>
        q.where((eb) =>
          policy.lockoutMinutes > 0
            ? eb("u.lockedAt", ">", minutesAgo(policy.lockoutMinutes))
            : eb.or([
                eb.and([
                  eb("u.isAdmin", "=", false),
                  eb("u.lockedAt", "is not", null),
                ]),
                eb.and([
                  eb("u.isAdmin", "=", true),
                  eb("u.lockedAt", ">", minutesAgo(ADMIN_LOCK_MINUTES)),
                ]),
              ]),
        ),
      )
      .$if(query.admin !== undefined, (q) =>
        q.where("u.isAdmin", "=", query.admin ?? false),
      )
      .$if(query.mfa === true, (q) => q.where(hasFactor))
      .$if(query.mfa === false, (q) =>
        q.where(sqlTag<boolean>`not ${hasFactor}`),
      )
      .$if(query.origin === "scim", (q) =>
        q.where("u.scimUserName", "is not", null),
      )
      .$if(query.origin === "sso", (q) =>
        q.where("u.scimUserName", "is", null).where(signOn),
      )
      .$if(query.origin === "local", (q) =>
        q
          .where("u.scimUserName", "is", null)
          .where(sqlTag<boolean>`not ${signOn}`),
      );
  const order = {
    name: sqlTag`lower(u.display_name)`,
    email: sqlTag`u.email`,
    created: sqlTag`u.created_at`,
    lastSeen: sqlTag`${lastSeen} nulls first`,
  }[query.sort];
  const direction = query.direction === "desc" ? sqlTag`desc` : sqlTag`asc`;
  const rows = await matching()
    .select([
      "u.id",
      "u.email",
      "u.displayName",
      "u.isAdmin",
      "u.isSupport",
      "u.isAuditor",
      "u.disabledAt",
      "u.createdAt",
      "u.scimUserName",
      "u.deprovisionedAt",
      "u.lockedAt",
      "u.disabledReason",
      sqlTag<boolean>`exists (select 1 from password_hashes p where p.user_id = u.id)`.as(
        "hasPassword",
      ),
      // Bound to a sign-on provider's subject (OIDC, SAML).
      signOn.as("signOn"),
      hasFactor.as("mfa"),
      lastSeen.as("lastSeen"),
      sqlTag<number>`(select count(distinct b.scope_id)::int from role_bindings b where b.user_id = u.id and b.scope = 'base')`.as(
        "bases",
      ),
    ])
    .orderBy(sqlTag`${order} ${direction}`)
    .orderBy("u.id", "asc")
    .offset(query.offset)
    .limit(query.limit)
    .execute();
  const total = await matching()
    .select(sqlTag<number>`count(*)::int`.as("value"))
    .executeTakeFirst();
  const users = rows.map(
    ({ scimUserName, deprovisionedAt, lockedAt, ...row }) => ({
      ...row,
      // Locked by failed sign-ins (ADR 0043); `until: null` waits for an
      // administrator.
      lock: (() => {
        const state = lockState(lockedAt, policy, row.isAdmin);
        return state.locked
          ? { until: state.until?.toISOString() ?? null }
          : null;
      })(),
      // Managed by an identity provider (SCIM), or removed by it.
      provisioned: scimUserName !== null,
      deprovisioned: deprovisionedAt !== null,
      origin: (scimUserName !== null
        ? "scim"
        : row.signOn
          ? "sso"
          : "local") satisfies AccountOrigin,
      createdAt: row.createdAt.toISOString(),
      disabledAt: row.disabledAt?.toISOString() ?? null,
      lastSeen: row.lastSeen ? new Date(row.lastSeen).toISOString() : null,
    }),
  );
  return { users, total: total?.value ?? 0 };
}

/** Disabling an account also ends its sessions; its API tokens stop working. */
export async function setUserDisabled(
  db: Database,
  actorId: string,
  userId: string,
  disabled: boolean,
): Promise<void> {
  if (actorId === userId || userId === ERASED_USER_ID) {
    throw new AppError("invalid_account");
  }
  await db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("users")
      .set(
        disabled
          ? { disabledAt: new Date(), disabledReason: "admin" }
          : // Enabled again: the time without activity starts over.
            {
              disabledAt: null,
              disabledReason: null,
              activeAt: new Date(),
              inactivityWarnedAt: null,
            },
      )
      .where("id", "=", userId)
      .returning("id")
      .execute();
    if (updated.length === 0) throw new AppError("unknown_account");
    if (disabled) {
      await tx.deleteFrom("sessions").where("userId", "=", userId).execute();
      await recordAuthEvent(tx, {
        action: "session_revoked",
        userId,
        actorId,
        method: "admin",
        detail: "admin_disable",
      });
    }
  });
}

export const updateAccountInputSchema = z
  .object({
    userId: z.uuid(),
    displayName: labelSchema,
    email: z.email().max(254),
  })
  .strict();

export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;

/**
 * Corrects an account's name or address, the administrator's own included.
 * An identity provider keeps the accounts it provisions: it would write
 * its values back. A link mailed to the old address stops working, so the
 * mailbox left behind cannot open the account. The sign-in trail names
 * what changed, never the values.
 */
export async function updateAccount(
  db: Database,
  actorId: string,
  input: UpdateAccountInput,
): Promise<{ displayName: boolean; email: boolean }> {
  if (input.userId === ERASED_USER_ID) {
    throw new AppError("invalid_account");
  }
  const email = input.email.toLowerCase();
  try {
    return await db.transaction().execute(async (tx) => {
      const account = await tx
        .selectFrom("users")
        .select(["email", "displayName", "scimUserName", "deprovisionedAt"])
        .where("id", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!account) throw new AppError("unknown_account");
      if (account.scimUserName !== null && account.deprovisionedAt === null) {
        throw new AppError("invalid_account");
      }
      const changed = {
        displayName: account.displayName !== input.displayName,
        email: account.email !== email,
      };
      if (!changed.displayName && !changed.email) return changed;
      await tx
        .updateTable("users")
        .set({ displayName: input.displayName, email })
        .where("id", "=", input.userId)
        .execute();
      if (changed.email) {
        await tx
          .deleteFrom("passwordResets")
          .where("userId", "=", input.userId)
          .where("usedAt", "is", null)
          .execute();
      }
      for (const detail of [
        changed.displayName ? ("display_name" as const) : null,
        changed.email ? ("email" as const) : null,
      ]) {
        if (!detail) continue;
        await recordAuthEvent(tx, {
          action: "account_updated",
          userId: input.userId,
          actorId,
          method: "admin",
          detail,
        });
      }
      return changed;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("account_already_exists");
    }
    throw error;
  }
}

/**
 * Creates an account for someone else, with no password: the link its
 * creator hands over or mails sets the first one. Sign-up policy and
 * sign-up domains do not apply, the administrator chose this address; the
 * domains people are invited from do, for the bases it joins. Those may be
 * any live base: Administration decides who sees which base (ADR 0057),
 * each role given here on the change trail under the administrator's
 * name, and the account's creation on the sign-in trail.
 */
export async function createAccount(
  db: Database,
  actorId: string,
  input: z.infer<typeof createAccountInputSchema>,
): Promise<{ id: string; email: string; displayName: string }> {
  const email = input.email.toLowerCase();
  const { memberships } = input;
  if (memberships.length > 0) await assertMemberDomain(db, email);
  try {
    return await withAudit(
      db,
      { userId: actorId, source: "web" },
      async (tx) => {
        if (memberships.length > 0) {
          const live = await tx
            .selectFrom("bases")
            .select("id")
            .where(
              "id",
              "in",
              memberships.map((row) => row.baseId),
            )
            .where(liveBase())
            .execute();
          if (live.length !== memberships.length) {
            throw new AppError("not_found");
          }
        }
        const row = await tx
          .insertInto("users")
          .values({
            email,
            displayName: input.displayName,
            isAdmin: input.admin,
          })
          .returning(["id", "email", "displayName"])
          .executeTakeFirst();
        if (!row) throw new AppError("no_row");
        for (const membership of memberships) {
          await bindRole(tx, row.id, membership.role, membership.baseId);
        }
        await recordAuthEvent(tx, {
          action: "account_created",
          userId: row.id,
          actorId,
          method: "admin",
          detail: input.admin ? "as_admin" : null,
        });
        return row;
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("account_already_exists");
    }
    throw error;
  }
}

/** Where an account comes from: made here, bound to a sign-on, or provisioned. */
export type AccountOrigin = "local" | "sso" | "scim";

/**
 * One account as Administration opens it (ROADMAP #19): identity, status,
 * lock, origin, how it signs in, its single sign-on identities, sessions,
 * API tokens, bases and roles (its own and those its groups give), and its
 * last sign-in events. Never a secret: no token, no subject a provider keeps.
 */
export async function getAccountDetail(db: Database, userId: string) {
  if (userId === ERASED_USER_ID) throw new AppError("invalid_account");
  const account = await db
    .selectFrom("users as u")
    .select([
      "u.id",
      "u.email",
      "u.displayName",
      "u.isAdmin",
      "u.isSupport",
      "u.isAuditor",
      "u.disabledAt",
      "u.disabledReason",
      "u.createdAt",
      "u.scimUserName",
      "u.deprovisionedAt",
      "u.lockedAt",
      sqlTag<boolean>`exists (select 1 from password_hashes p where p.user_id = u.id)`.as(
        "hasPassword",
      ),
    ])
    .where("u.id", "=", userId)
    .executeTakeFirst();
  if (!account) throw new AppError("unknown_account");
  const [policy, factors, identities, sessions, tokens, bases, signIns] =
    await Promise.all([
      readSettings(db),
      factorMethods(db, userId),
      db
        .selectFrom("ssoIdentities")
        .select(["provider", "issuer", "lastSeenAt"])
        .where("userId", "=", userId)
        .orderBy("provider")
        .execute(),
      db
        .selectFrom("sessions")
        .select(["id", "createdAt", "expiresAt"])
        .where("userId", "=", userId)
        .where("expiresAt", ">", new Date())
        .orderBy("createdAt", "desc")
        .limit(50)
        .execute(),
      listApiTokens(db, userId),
      db
        .selectFrom("roleBindings as b")
        .innerJoin("bases as base", "base.id", "b.scopeId")
        .leftJoin("groups as g", "g.id", "b.groupId")
        .select(["base.id", "base.name", "b.role", "g.displayName as viaGroup"])
        .where("b.userId", "=", userId)
        .where("b.scope", "=", "base")
        .where(liveBase("base"))
        .orderBy("base.name", "asc")
        .orderBy("g.displayName", "asc")
        .execute(),
      db
        .selectFrom("authEvents")
        .select(["id", "occurredAt", "action", "method", "detail", "ip"])
        .where("userId", "=", userId)
        .orderBy("occurredAt", "desc")
        .limit(20)
        .execute(),
    ]);
  const lock = lockState(account.lockedAt, policy, account.isAdmin);
  const origin: AccountOrigin =
    account.scimUserName !== null
      ? "scim"
      : identities.length > 0
        ? "sso"
        : "local";
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    isAdmin: account.isAdmin,
    isSupport: account.isSupport,
    isAuditor: account.isAuditor,
    origin,
    hasPassword: account.hasPassword,
    provisioned: account.scimUserName !== null,
    deprovisioned: account.deprovisionedAt !== null,
    disabledAt: account.disabledAt?.toISOString() ?? null,
    disabledReason: account.disabledReason,
    createdAt: account.createdAt.toISOString(),
    lock: lock.locked ? { until: lock.until?.toISOString() ?? null } : null,
    factors,
    identities: identities.map((row) => ({
      provider: row.provider,
      issuer: row.issuer,
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
    sessions: sessions.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    })),
    tokens,
    bases: bases.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      viaGroup: row.viaGroup,
    })),
    signIns: signIns.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      method: row.method,
      detail: row.detail,
      ip: row.ip,
    })),
  };
}

/**
 * The account an administrator gives a role on a base, changes it, or
 * takes it away, and that live base (ROADMAP #68, ADR 0057). Returns the
 * account's address, which the invitation domains are checked against.
 */
export async function assertGrantable(
  db: Database,
  input: { userId: string; baseId: string },
): Promise<{ email: string }> {
  if (input.userId === ERASED_USER_ID) throw new AppError("invalid_account");
  const account = await db
    .selectFrom("users")
    .select("email")
    .where("id", "=", input.userId)
    .executeTakeFirst();
  if (!account) throw new AppError("unknown_account");
  const base = await db
    .selectFrom("bases")
    .select("id")
    .where("id", "=", input.baseId)
    .where(liveBase())
    .executeTakeFirst();
  if (!base) throw new AppError("not_found");
  return account;
}

/**
 * Live bases to give a person a role on, by name: any base, since
 * Administration decides who sees which (ADR 0057). Each comes with the
 * names of its owners, so two bases of the same name can be told apart.
 */
export async function listBaseChoices(
  db: Database,
  input: { search?: string | undefined; limit: number },
) {
  const pattern = input.search
    ? `%${input.search.replace(/[%_\\]/g, "\\$&")}%`
    : undefined;
  return db
    .selectFrom("bases as b")
    .select([
      "b.id",
      "b.name",
      sqlTag<
        string[]
      >`array(select u.display_name from role_bindings r join users u on u.id = r.user_id where r.scope = 'base' and r.scope_id = b.id and r.role = 'owner' and r.group_id is null order by u.display_name limit 3)`.as(
        "owners",
      ),
    ])
    .where(liveBase("b"))
    .$if(pattern !== undefined, (query) =>
      query.where("b.name", "ilike", pattern ?? ""),
    )
    .orderBy("b.name", "asc")
    .orderBy("b.id", "asc")
    .limit(input.limit)
    .execute();
}

/**
 * Gives or takes away administration. The instance keeps one active
 * administrator at least. The change is on the sign-in trail under the
 * name of who made it; one that changes nothing leaves no event.
 */
export async function setUserAdmin(
  db: Database,
  actorId: string,
  userId: string,
  admin: boolean,
): Promise<void> {
  if (userId === ERASED_USER_ID) {
    throw new AppError("invalid_account");
  }
  await db.transaction().execute(async (tx) => {
    if (!admin) {
      // Locking the active administrators keeps two of them from removing
      // each other at the same moment and leaving none.
      const others = await tx
        .selectFrom("users")
        .select("id")
        .where("isAdmin", "=", true)
        .where("disabledAt", "is", null)
        .where("id", "<>", userId)
        .forUpdate()
        .execute();
      if (others.length === 0) {
        throw new AppError("invalid_account");
      }
    }
    const updated = await tx
      .updateTable("users")
      .set({ isAdmin: admin })
      .where("id", "=", userId)
      .where("isAdmin", "=", !admin)
      .returning("id")
      .execute();
    if (updated.length === 0) {
      await assertAccount(tx, userId);
      return;
    }
    await recordAuthEvent(tx, {
      action: "account_updated",
      userId,
      actorId,
      method: "admin",
      detail: admin ? "admin_granted" : "admin_revoked",
    });
  });
}

/**
 * Grants or revokes the support (helpdesk) flag (ADR 0054), on the
 * sign-in trail as administration is.
 */
export async function setUserSupport(
  db: Database,
  actorId: string,
  userId: string,
  support: boolean,
): Promise<void> {
  if (userId === ERASED_USER_ID) {
    throw new AppError("invalid_account");
  }
  await db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("users")
      .set({ isSupport: support })
      .where("id", "=", userId)
      .where("isSupport", "=", !support)
      .returning("id")
      .execute();
    if (updated.length === 0) {
      await assertAccount(tx, userId);
      return;
    }
    await recordAuthEvent(tx, {
      action: "account_updated",
      userId,
      actorId,
      method: "admin",
      detail: support ? "support_granted" : "support_revoked",
    });
  });
}

/**
 * Makes an account an auditor, or no longer one (ADR 0071): it reads
 * Administration and changes nothing. On the sign-in trail as
 * administration and support are.
 */
export async function setUserAuditor(
  db: Database,
  actorId: string,
  userId: string,
  auditor: boolean,
): Promise<void> {
  if (userId === ERASED_USER_ID) {
    throw new AppError("invalid_account");
  }
  await db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("users")
      .set({ isAuditor: auditor })
      .where("id", "=", userId)
      .where("isAuditor", "=", !auditor)
      .returning("id")
      .execute();
    if (updated.length === 0) {
      await assertAccount(tx, userId);
      return;
    }
    await recordAuthEvent(tx, {
      action: "account_updated",
      userId,
      actorId,
      method: "admin",
      detail: auditor ? "auditor_granted" : "auditor_revoked",
    });
  });
}

/** Refuses an id no account has: an unchanged flag is not an unknown one. */
async function assertAccount(db: Database, userId: string): Promise<void> {
  const account = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!account) throw new AppError("unknown_account");
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

type Check = { ok: boolean; ms: number; detail?: string };

async function timed(run: () => Promise<unknown>): Promise<Check> {
  const started = performance.now();
  try {
    await run();
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.name : "Error",
    };
  }
}

export async function instanceHealth(deps: {
  db: Database;
  bus: Bus;
  files: FileStore;
}) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const database = await timed(() => sqlTag`select 1`.execute(deps.db));
  // Realtime rides on a PostgreSQL connection that listens (ADR 0009).
  const realtime = deps.bus.listening()
    ? { ok: true, ms: 0, detail: "listening" }
    : { ok: false, ms: 0, detail: "reconnecting" };
  const checked = await timed(() => deps.files.check());
  const storage = {
    ...checked,
    detail: checked.ok
      ? deps.files.driver
      : `${deps.files.driver}: ${checked.detail ?? "error"}`,
  };
  // Background work waiting in graphile-worker; permanently failed jobs aside.
  const queued = await sqlTag<{ value: number }>`
    select count(*)::int as value from graphile_worker.jobs
    where locked_at is null and attempts < max_attempts
  `
    .execute(deps.db)
    .then((result) => result.rows[0]?.value ?? 0)
    .catch(() => -1);
  const value = sqlTag<number>`count(*)::int`.as("value");
  const pending = await deps.db
    .selectFrom("webhookDeliveries")
    .select(value)
    .where("status", "=", "pending")
    .executeTakeFirst();
  const failedDeliveries = await deps.db
    .selectFrom("webhookDeliveries")
    .select(value)
    .where("status", "=", "failed")
    .where("createdAt", ">", since)
    .executeTakeFirst();
  const failedRuns = await deps.db
    .selectFrom("automationRuns")
    .select(value)
    .where("status", "=", "failed")
    .where("startedAt", ">", since)
    .executeTakeFirst();
  const jobCounts = await deps.db
    .selectFrom("jobs")
    .select(["status", value])
    .where((eb) =>
      eb.or([
        eb("status", "in", ["queued", "running"]),
        eb.and([eb("status", "=", "failed"), eb("createdAt", ">", since)]),
      ]),
    )
    .groupBy("status")
    .execute();
  const jobsIn = (status: string) =>
    jobCounts.find((row) => row.status === status)?.value ?? 0;
  const userCount = await deps.db
    .selectFrom("users")
    .select(value)
    .where("id", "<>", ERASED_USER_ID)
    .executeTakeFirst();
  const baseCount = await deps.db
    .selectFrom("bases")
    .select(value)
    .where("deletedAt", "is", null)
    .executeTakeFirst();
  const tableCount = await deps.db
    .selectFrom("dataTables")
    .select(value)
    .where("deletedAt", "is", null)
    .executeTakeFirst();
  const activeSessions = await deps.db
    .selectFrom("sessions")
    .select(value)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  const files = await deps.db
    .selectFrom("attachments")
    .select([value, sqlTag<string>`coalesce(sum(size), 0)::text`.as("bytes")])
    .executeTakeFirst();
  const memory = process.memoryUsage();
  return {
    build: BUILD,
    checks: { database, realtime, storage },
    queue: {
      events: queued,
      pendingDeliveries: pending?.value ?? 0,
      failedDeliveries24h: failedDeliveries?.value ?? 0,
      failedRuns24h: failedRuns?.value ?? 0,
      jobsQueued: jobsIn("queued"),
      jobsRunning: jobsIn("running"),
      failedJobs24h: jobsIn("failed"),
    },
    counts: {
      users: userCount?.value ?? 0,
      bases: baseCount?.value ?? 0,
      tables: tableCount?.value ?? 0,
      activeSessions: activeSessions?.value ?? 0,
      files: files?.value ?? 0,
      fileBytes: Number(files?.bytes ?? 0),
    },
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

const IGNORED_KEYS = new Set(["ag_updated_at", "ag_updated_by", "ag_seq"]);

/** Field names a change touched, from the audit snapshots. */
export function changedKeys(oldValue: unknown, newValue: unknown): string[] {
  const before = (
    oldValue && typeof oldValue === "object" ? oldValue : {}
  ) as Record<string, unknown>;
  const after = (
    newValue && typeof newValue === "object" ? newValue : {}
  ) as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => key !== "id" && !IGNORED_KEYS.has(key))
    .filter(
      (key) =>
        JSON.stringify(before[key] ?? null) !==
        JSON.stringify(after[key] ?? null),
    )
    .sort();
}

export async function instanceAudit(
  db: Database,
  input: {
    userId?: string;
    tableId?: string;
    action?: AuditAction;
    source?: string;
    before?: string;
    limit: number;
  },
) {
  let query = db
    .selectFrom("auditEvents as e")
    .leftJoin("users as u", "u.id", "e.userId")
    .leftJoin("dataTables as t", "t.id", "e.tableId")
    .leftJoin("bases as b", "b.id", "t.baseId")
    .select([
      "e.id",
      "e.occurredAt",
      "e.action",
      "e.recordId",
      "e.reason",
      "e.source",
      "e.oldValue",
      "e.newValue",
      "e.userId",
      "u.displayName as userName",
      "e.tableId",
      "t.name as tableName",
      "b.name as baseName",
    ]);
  if (input.userId) query = query.where("e.userId", "=", input.userId);
  if (input.tableId) query = query.where("e.tableId", "=", input.tableId);
  if (input.action) query = query.where("e.action", "=", input.action);
  if (input.source) {
    const prefix = `${input.source.replace(/[%_\\]/g, "\\$&")}%`;
    query = query.where("e.source", "ilike", prefix);
  }
  if (input.before) {
    query = query.where("e.occurredAt", "<", new Date(input.before));
  }
  const rows = await query
    .orderBy("e.occurredAt", "desc")
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit).map((row) => ({
    ...row,
    // An export changed no field: it says what was taken out.
    exported: row.action === "export" ? exportRecordOf(row.newValue) : null,
    // Nor did a purge: it says what it removed from the trail.
    purged: row.action === "purge" ? purgeRecordOf(row.newValue) : null,
  }));
  // A base's file names its base itself, not a table of it.
  const baseIds = [
    ...new Set(page.flatMap((row) => row.exported?.baseId ?? [])),
  ];
  const baseNames = new Map(
    baseIds.length === 0
      ? []
      : (
          await db
            .selectFrom("bases")
            .select(["id", "name"])
            .where("id", "in", baseIds)
            .execute()
        ).map((base) => [base.id, base.name]),
  );
  return {
    events: page.map(({ oldValue, newValue, exported, purged, ...row }) => ({
      ...row,
      baseName: row.baseName ?? baseNames.get(exported?.baseId ?? "") ?? null,
      occurredAt: row.occurredAt.toISOString(),
      // Field names only: values stay in the table's own history, behind its rights.
      fields: exported || purged ? [] : changedKeys(oldValue, newValue),
      purged: purged ? { events: purged.events, before: purged.before } : null,
      exported: exported
        ? {
            kind: exported.kind,
            format: exported.format,
            rows: exported.rows ?? null,
          }
        : null,
    })),
    next:
      rows.length > input.limit
        ? (page.at(-1)?.occurredAt.toISOString() ?? null)
        : null,
  };
}
