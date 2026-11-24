/**
 * What an instance administrator does beyond settings (ADRs 0042, 0051):
 * read the sign-in trail, end sessions, take back an account's factors or
 * tokens, erase a disabled account's identity, watch the queue and failed
 * deliveries, export audits and access, and gather a support bundle.
 * Every action on an account names its actor in the sign-in trail.
 */
import { dropAccountTokens } from "./auth/tokens.js";
import type { AuditAction, AuthAction, Database } from "@anygriddb/db";
import { AppError } from "@anygriddb/core";
import { sql as sqlTag } from "kysely";
import { z } from "zod";
import { recordAuthEvent } from "./auth/auth-events.js";
import { withAudit } from "./data/audit-context.js";
import { eraseAccount, ERASED_USER_ID } from "./data/erasure.js";
import { soleOwnerBases } from "./data/members.js";
import type { Env } from "./env.js";
import type { FileStore } from "./files/index.js";
import { resolveOidc } from "./integrations/oidc.js";
import { resolveSaml } from "./integrations/saml.js";
import { loadSiemRow } from "./integrations/siem.js";
import { resolveSmtp } from "./integrations/smtp.js";
import { smtpReady } from "./mail.js";
import { operatorFixedFromEnv } from "./operator-fixed.js";
import type { SourceSettings } from "./sources/types.js";
import { readSettings } from "./settings.js";

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

const CSV_BOM = "﻿";

/**
 * RFC 4180 quoting. A field a spreadsheet would run as a formula (=, +, -,
 * @, tab, carriage return first) is prefixed with a quote, so a display
 * name cannot become code in the administrator's spreadsheet.
 */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csv(rows: readonly (readonly string[])[]): string {
  return CSV_BOM + rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

export function auditEventsCsv(
  events: readonly {
    occurredAt: string;
    action: AuditAction;
    /** The catalog table a `catalog` event changed, when the trail kept it. */
    catalogTable?: string | null;
    userId: string | null;
    userName: string | null;
    baseName: string | null;
    tableId: string | null;
    tableName: string | null;
    recordId: string | null;
    source: string | null;
    reason: string | null;
    fields: string[];
    exported: { kind: string; format: string; rows: number | null } | null;
    purged: { events: number; before: string } | null;
    opened: { until: string } | null;
  }[],
): string {
  return csv([
    [
      "occurredAt",
      "action",
      "catalogTable",
      "userId",
      "userName",
      "baseName",
      "tableId",
      "tableName",
      "recordId",
      "source",
      "reason",
      "fields",
      "exported",
      "purged",
      "opened",
    ],
    ...events.map((event) => [
      event.occurredAt,
      event.action,
      event.catalogTable ?? "",
      event.userId ?? "",
      event.userName ?? "",
      event.baseName ?? "",
      event.tableId ?? "",
      event.tableName ?? "",
      event.recordId ?? "",
      event.source ?? "",
      event.reason ?? "",
      event.fields.join(";"),
      event.exported
        ? [
            event.exported.kind,
            event.exported.format,
            ...(event.exported.rows === null
              ? []
              : [`${String(event.exported.rows)} rows`]),
          ].join(" ")
        : "",
      event.purged
        ? `${String(event.purged.events)} events before ${event.purged.before}`
        : "",
      event.opened ? `read until ${event.opened.until}` : "",
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* Sign-in trail                                                       */
/* ------------------------------------------------------------------ */

type AuthEventRow = Awaited<
  ReturnType<typeof instanceAuthAudit>
>["events"][number];

export async function instanceAuthAudit(
  db: Database,
  input: {
    userId?: string;
    action?: AuthAction;
    before?: string;
    from?: string;
    to?: string;
    /** `asc` is oldest first. The cursor walks the same way. */
    direction?: "asc" | "desc";
    limit: number;
  },
) {
  const asc = input.direction === "asc";
  const rows = await db
    .selectFrom("authEvents as e")
    .leftJoin("users as u", "u.id", "e.userId")
    .leftJoin("users as a", "a.id", "e.actorId")
    .select([
      "e.id",
      "e.occurredAt",
      "e.action",
      "e.method",
      "e.detail",
      "e.ip",
      "e.userId",
      "u.displayName as userName",
      "e.actorId",
      "a.displayName as actorName",
      sqlTag<string>`to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        "occurredExact",
      ),
    ])
    .$if(input.userId !== undefined, (query) =>
      query.where("e.userId", "=", input.userId ?? ""),
    )
    .$if(input.action !== undefined, (query) =>
      query.where("e.action", "=", input.action ?? "login_success"),
    )
    .$if(input.from !== undefined, (query) =>
      query.where("e.occurredAt", ">=", new Date(input.from ?? 0)),
    )
    .$if(input.to !== undefined, (query) =>
      query.where("e.occurredAt", "<=", new Date(input.to ?? 0)),
    )
    .$if(input.before !== undefined, (query) =>
      asc
        ? query.where(
            sqlTag<boolean>`e.occurred_at > ${input.before ?? ""}::timestamptz`,
          )
        : query.where("e.occurredAt", "<", new Date(input.before ?? 0)),
    )
    .orderBy("e.occurredAt", asc ? "asc" : "desc")
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  return {
    events: page.map(({ occurredExact: _exact, ...row }) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
    })),
    next:
      rows.length > input.limit
        ? asc
          ? (page.at(-1)?.occurredExact ?? null)
          : (page.at(-1)?.occurredAt.toISOString() ?? null)
        : null,
  };
}

export function authEventsCsv(events: readonly AuthEventRow[]): string {
  return csv([
    [
      "occurredAt",
      "action",
      "method",
      "detail",
      "userId",
      "userName",
      "actorId",
      "actorName",
      "ip",
    ],
    ...events.map((event) => [
      event.occurredAt,
      event.action,
      event.method ?? "",
      event.detail ?? "",
      event.userId ?? "",
      event.userName ?? "",
      event.actorId ?? "",
      event.actorName ?? "",
      event.ip ?? "",
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export async function listSessions(
  db: Database,
  input?: { limit: number; offset?: number },
) {
  const { limit = 500, offset = 0 } = input ?? {};
  const now = new Date();
  const counted = await db
    .selectFrom("sessions as s")
    .select((eb) => eb.fn.countAll<string>().as("value"))
    .where("s.expiresAt", ">", now)
    .executeTakeFirst();
  const total = Number(counted?.value ?? 0);
  const rows = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.userId")
    .select([
      "s.id",
      "s.userId",
      "u.email",
      "u.displayName",
      "u.isAdmin",
      "s.createdAt",
      "s.expiresAt",
    ])
    .where("s.expiresAt", ">", now)
    .orderBy("s.createdAt", "desc")
    .offset(offset)
    .limit(limit)
    .execute();
  return {
    total,
    sessions: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    })),
  };
}

/** Ends one session; returns whose it was. */
export async function endSession(
  db: Database,
  actorId: string,
  sessionId: string,
): Promise<{ userId: string }> {
  return db.transaction().execute(async (tx) => {
    const ended = await tx
      .deleteFrom("sessions")
      .where("id", "=", sessionId)
      .returning("userId")
      .executeTakeFirst();
    if (!ended) throw new AppError("not_found");
    await recordAuthEvent(tx, {
      action: "session_revoked",
      userId: ended.userId,
      actorId,
      method: "admin",
      detail: "admin_revoke_session",
    });
    return ended;
  });
}

/** Ends every session of one account. */
export async function endUserSessions(
  db: Database,
  actorId: string,
  userId: string,
): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const ended = await tx
      .deleteFrom("sessions")
      .where("userId", "=", userId)
      .returning("id")
      .execute();
    if (ended.length > 0) {
      await recordAuthEvent(tx, {
        action: "session_revoked",
        userId,
        actorId,
        method: "admin",
        detail: "admin_revoke_user",
      });
    }
    return ended.length;
  });
}

/**
 * Ends the sessions of everyone but the actor; for maintenance, of
 * everyone who is not an administrator; for support, of everyone who holds
 * no role of Administration (`helpdeskReach`). One event for the sweep.
 * Returns the accounts signed out.
 */
export async function endOtherSessions(
  db: Database,
  actorId: string,
  scope: "everyone" | "non_admins" | "no_role",
): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    const ended = await tx
      .deleteFrom("sessions")
      .where("userId", "<>", actorId)
      .$if(scope === "non_admins", (query) =>
        query.where("userId", "in", (eb) =>
          eb.selectFrom("users").select("id").where("isAdmin", "=", false),
        ),
      )
      .$if(scope === "no_role", (query) =>
        query.where("userId", "in", (eb) =>
          eb
            .selectFrom("users")
            .select("id")
            .where("isAdmin", "=", false)
            .where("isSupport", "=", false)
            .where("isAuditor", "=", false),
        ),
      )
      .returning("userId")
      .execute();
    if (ended.length > 0) {
      await recordAuthEvent(tx, {
        action: "session_revoked",
        actorId,
        method: "admin",
        detail: scope === "everyone" ? "admin_revoke_all" : "maintenance",
      });
    }
    return [...new Set(ended.map((row) => row.userId))];
  });
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Another account than the administrator's own, and one that exists. The
 * account erased people become is not one to act on.
 */
export async function otherAccount(
  db: Database,
  actorId: string,
  userId: string,
): Promise<void> {
  if (actorId === userId || userId === ERASED_USER_ID) {
    throw new AppError("invalid_account");
  }
  const found = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!found) throw new AppError("unknown_account");
}

/**
 * Whether the account acting may do a helpdesk's act to this one (ADR
 * 0054). An administrator may, to anyone. Support may only to an account
 * that holds no role of Administration: clearing an administrator's
 * factors and taking their reset link, where no mail is set up, would
 * hand support the administrator's account, and the same with another
 * support or an auditor, whose exports support is kept from.
 */
export async function helpdeskReach(
  db: Database,
  actor: { id: string; isAdmin: boolean },
  userId: string,
): Promise<void> {
  if (actor.isAdmin) return;
  const target = await db
    .selectFrom("users")
    .select(["isAdmin", "isSupport", "isAuditor"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (target && (target.isAdmin || target.isSupport || target.isAuditor)) {
    throw new AppError("account_out_of_reach");
  }
}

export const adminEraseInputSchema = z
  .object({
    userId: z.uuid(),
    /** Must match the account's email (case-insensitive). */
    email: z.email().max(254),
    /** Who takes the bases this account alone owns, when it has any. */
    successorEmail: z.email().max(254).optional(),
  })
  .strict();

type AdminEraseInput = z.infer<typeof adminEraseInputSchema>;

/**
 * What the delete dialog needs before confirming: whether an identity
 * provider still manages the account, and the live bases it alone owns,
 * which need an account to take them. An enabled account may be deleted:
 * the deletion disables it first (ADR 0059).
 */
export async function eraseInfo(
  db: Database,
  actorId: string,
  userId: string,
): Promise<{
  email: string;
  disabled: boolean;
  provisioned: boolean;
  soleOwnerBases: { id: string; name: string }[];
}> {
  await otherAccount(db, actorId, userId);
  const account = await db
    .selectFrom("users")
    .select(["email", "disabledAt", "scimUserName", "deprovisionedAt"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!account) throw new AppError("unknown_account");
  return {
    email: account.email,
    disabled: account.disabledAt !== null,
    provisioned:
      account.scimUserName !== null && account.deprovisionedAt === null,
    soleOwnerBases: await soleOwnerBases(db, userId),
  };
}

/**
 * Deletes another account on the path self-service erasure takes, after
 * the administrator confirms its email. An enabled account is disabled in
 * the same transaction (ADR 0059); the identity provider keeps actively
 * provisioned accounts; the bases the account alone owns go to the account
 * the administrator names.
 */
export async function eraseOtherAccount(
  db: Database,
  actorId: string,
  input: AdminEraseInput,
): Promise<void> {
  await otherAccount(db, actorId, input.userId);
  await eraseAccount(db, input.userId, {
    actorId,
    email: input.email,
    successorEmail: input.successorEmail,
  });
}

/**
 * Removes an account's second factors and backup codes, and ends its
 * sessions: the person signs in with their password and enrolls again. For
 * a lost phone or key. Never one's own.
 */
export async function clearFactors(
  db: Database,
  actorId: string,
  userId: string,
): Promise<void> {
  await otherAccount(db, actorId, userId);
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom("totpSecrets").where("userId", "=", userId).execute();
    await tx
      .deleteFrom("webauthnCredentials")
      .where("userId", "=", userId)
      .execute();
    await tx.deleteFrom("emailFactors").where("userId", "=", userId).execute();
    await tx.deleteFrom("emailOtpCodes").where("userId", "=", userId).execute();
    await tx.deleteFrom("backupCodes").where("userId", "=", userId).execute();
    await tx.deleteFrom("sessions").where("userId", "=", userId).execute();
    await recordAuthEvent(tx, {
      action: "factors_cleared",
      userId,
      actorId,
      method: "admin",
    });
  });
}

/**
 * Forgets which provider subjects an account is bound to: its next sign-on
 * binds it again, to the subject that brings its address (an account made
 * again at the provider). Its sessions stay.
 */
export async function unlinkSignOn(
  db: Database,
  actorId: string,
  userId: string,
): Promise<number> {
  await otherAccount(db, actorId, userId);
  return db.transaction().execute(async (tx) => {
    const removed = await tx
      .deleteFrom("ssoIdentities")
      .where("userId", "=", userId)
      .executeTakeFirst();
    const count = Number(removed.numDeletedRows);
    if (count > 0) {
      await recordAuthEvent(tx, {
        action: "sso_unlinked",
        userId,
        actorId,
        method: "admin",
      });
    }
    return count;
  });
}

/** Revokes every API token of an account (a leaked token, a departure). */
export async function revokeUserTokens(
  db: Database,
  actorId: string,
  userId: string,
): Promise<number> {
  await otherAccount(db, actorId, userId);
  return db.transaction().execute(async (tx) => {
    const revoked = await dropAccountTokens(tx, userId);
    if (revoked.length > 0) {
      await recordAuthEvent(tx, {
        action: "tokens_revoked",
        userId,
        actorId,
        method: "admin",
      });
    }
    return revoked.length;
  });
}

/**
 * What an administrator may end as sign-in moves to the provider: the
 * sessions opened with a password and the API tokens of everyone but the
 * administrators. Sessions the provider opened stay. Refused unless the
 * instance is SSO-only. Returns what ended, and whose.
 */
export async function endPasswordAccess(
  db: Database,
  actorId: string,
): Promise<{ sessions: number; tokens: number; users: string[] }> {
  return db.transaction().execute(async (tx) => {
    if (!(await readSettings(tx)).ssoOnly) {
      throw new AppError("sso_required");
    }
    const ended = await tx
      .deleteFrom("sessions")
      .where("signOn", "is", null)
      .where("userId", "in", (eb) =>
        eb.selectFrom("users").select("id").where("isAdmin", "=", false),
      )
      .returning("userId")
      .execute();
    if (ended.length > 0) {
      await recordAuthEvent(tx, {
        action: "session_revoked",
        actorId,
        method: "admin",
        detail: "sso_only",
      });
    }
    const holders = await tx
      .selectFrom("apiTokens as k")
      .innerJoin("users as u", "u.id", "k.userId")
      .select("k.userId")
      .distinct()
      .where("u.isAdmin", "=", false)
      .execute();
    let tokens = 0;
    for (const { userId } of holders) {
      tokens += (await dropAccountTokens(tx, userId)).length;
      await recordAuthEvent(tx, {
        action: "tokens_revoked",
        userId,
        actorId,
        method: "admin",
        detail: "sso_only",
      });
    }
    return {
      sessions: ended.length,
      tokens,
      users: [
        ...new Set([
          ...ended.map((row) => row.userId),
          ...holders.map((row) => row.userId),
        ]),
      ],
    };
  });
}

/**
 * Revokes every API token of the instance at once, in an emergency (a
 * leaked token, a compromised script): each account that had one gets
 * the event on its trail. Tokens made afterwards work.
 */
export async function revokeAllTokens(
  db: Database,
  actorId: string,
): Promise<number> {
  return db.transaction().execute(async (tx) => {
    await tx.deleteFrom("oauthAuthorizationCodes").execute();
    const revoked = await tx
      .deleteFrom("apiTokens")
      .returning("userId")
      .execute();
    for (const userId of new Set(revoked.map((row) => row.userId))) {
      await recordAuthEvent(tx, {
        action: "tokens_revoked",
        userId,
        actorId,
        method: "admin",
        detail: "every_token",
      });
    }
    return revoked.length;
  });
}

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Pending invitations across the instance, which an administrator sends
 * again or withdraws: Administration decides who sees which base (ADR 0057).
 */
export async function listPendingInvitations(db: Database) {
  const rows = await db
    .selectFrom("invitations as i")
    .innerJoin("bases as b", "b.id", "i.baseId")
    .leftJoin("users as u", "u.id", "i.invitedBy")
    .select([
      "i.id",
      "i.baseId",
      "b.name as baseName",
      "i.email",
      "i.role",
      "u.displayName as invitedByName",
      "i.createdAt",
      "i.expiresAt",
    ])
    .where("i.acceptedAt", "is", null)
    .where("i.expiresAt", ">", new Date())
    .where("b.deletedAt", "is", null)
    .orderBy("i.createdAt", "desc")
    .limit(200)
    .execute();
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export async function withdrawInvitation(
  db: Database,
  actorId: string,
  invitationId: string,
): Promise<void> {
  const withdrawn = await withAudit(
    db,
    { userId: actorId, source: "web" },
    (tx) =>
      tx
        .deleteFrom("invitations")
        .where("id", "=", invitationId)
        .where("acceptedAt", "is", null)
        .returning("id")
        .executeTakeFirst(),
  );
  if (!withdrawn) throw new AppError("invalid_invitation");
}

/* ------------------------------------------------------------------ */
/* Access report                                                       */
/* ------------------------------------------------------------------ */

/** Every account, its bases and roles, and its last sign-in, as CSV. */
export async function accessReportCsv(db: Database): Promise<string> {
  const users = await db
    .selectFrom("users as u")
    .where("u.id", "<>", ERASED_USER_ID)
    .select([
      "u.id",
      "u.email",
      "u.displayName",
      "u.isAdmin",
      "u.disabledAt",
      "u.lastSignInAt as lastSignIn",
    ])
    .orderBy("u.createdAt", "asc")
    .execute();
  const bindings = await db
    .selectFrom("roleBindings as r")
    .innerJoin("bases as b", "b.id", "r.scopeId")
    .select(["r.userId", "b.name", "r.role"])
    .where("r.scope", "=", "base")
    .where("b.deletedAt", "is", null)
    .orderBy("b.name")
    .execute();
  const byUser = new Map<string, string[]>();
  for (const row of bindings) {
    if (!row.userId) continue;
    const list = byUser.get(row.userId) ?? [];
    list.push(`${row.name}:${row.role}`);
    byUser.set(row.userId, list);
  }
  return csv([
    ["email", "displayName", "admin", "disabled", "bases", "lastSignIn"],
    ...users.map((user) => [
      user.email,
      user.displayName,
      String(user.isAdmin),
      String(user.disabledAt !== null),
      (byUser.get(user.id) ?? []).join(";"),
      user.lastSignIn ? new Date(user.lastSignIn).toISOString() : "",
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* Deliveries                                                          */
/* ------------------------------------------------------------------ */

/** Webhook deliveries that gave up, with the webhook's host only. */
export async function listFailedDeliveries(
  db: Database,
  input: { limit: number; offset?: number },
) {
  const offset = input.offset ?? 0;
  const counted = await db
    .selectFrom("webhookDeliveries as d")
    .select((eb) => eb.fn.countAll<string>().as("value"))
    .where("d.status", "=", "failed")
    .executeTakeFirst();
  const total = Number(counted?.value ?? 0);
  const rows = await db
    .selectFrom("webhookDeliveries as d")
    .innerJoin("webhooks as w", "w.id", "d.webhookId")
    .select([
      "d.id",
      "d.event",
      "d.attempts",
      "d.error",
      "d.createdAt",
      "w.name as webhookName",
      "w.target",
    ])
    .where("d.status", "=", "failed")
    .orderBy("d.createdAt", "desc")
    .offset(offset)
    .limit(input.limit)
    .execute();
  return {
    total,
    deliveries: rows.map(({ target, ...row }) => ({
      ...row,
      // The path and query of a target can carry a secret.
      host: hostOf(target),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

function hostOf(target: string): string | null {
  try {
    return new URL(target).host;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

/**
 * How this instance is configured, as facts an operator may share: which
 * features are set up, never a secret, a key, or a password.
 */
export async function instanceRuntime(deps: {
  db: Database;
  env: Env;
  files: FileStore;
  sources: SourceSettings;
}) {
  const settings = await readSettings(deps.db);
  const env = deps.env;
  const [smtp, oidc, saml, siem] = await Promise.all([
    resolveSmtp(deps.db, env),
    resolveOidc(deps.db, env),
    resolveSaml(deps.db, env),
    loadSiemRow(deps.db),
  ]);
  const operator = operatorFixedFromEnv(env);
  return {
    publicUrl: operator.publicUrl,
    storage: deps.files.driver,
    trustedProxies: operator.trustedProxies,
    smtp: smtpReady(smtp.config),
    oidc: oidc.config !== null,
    saml: saml.config !== null,
    siem: siem !== null,
    syslog: env.SYSLOG !== undefined,
    sourceHosts: [...deps.sources.allowedHosts],
    signup: settings.signup,
    maintenance: settings.maintenance,
    // The security policy (ADR 0043); domains as a count only.
    security: {
      mfaScope: settings.mfaScope,
      ssoMfa: settings.ssoMfa,
      lockoutThreshold: settings.lockoutThreshold,
      lockoutMinutes: settings.lockoutMinutes,
      sessionIdleMinutes: settings.sessionIdleMinutes,
      sessionMaxHours: settings.sessionMaxHours,
      passwordMinLength: settings.passwordMinLength,
      passwordReset: settings.passwordReset,
      tokenMaxDays: settings.tokenMaxDays,
      publicLinks: settings.publicLinks,
      signupDomains: settings.signupDomains.length,
      authRetentionDays: settings.authRetentionDays,
      invitations: settings.invitations,
      baseCreation: settings.baseCreation,
      apiTokens: settings.apiTokens,
      inactiveDays: settings.inactiveDays,
      lockAlerts: settings.lockAlerts,
    },
  };
}

/** Rows in the sign-in trail, to show its size next to its retention. */
export async function authEventCount(db: Database): Promise<number> {
  const row = await db
    .selectFrom("authEvents")
    .select(sqlTag<number>`count(*)::int`.as("value"))
    .executeTakeFirst();
  return row?.value ?? 0;
}
