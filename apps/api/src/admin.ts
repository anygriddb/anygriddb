import {
  AppError,
  emailDomainAllowed,
  lockState,
  memberDomainAllowed,
  parseAdminEmails,
  signupAllowed,
} from "@anygriddb/core";
import type { AuditAction, Database } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import type { Bus } from "./realtime/bus.js";
import { factorMethods } from "./auth/access.js";
import { recordAuthEvent } from "./auth/auth-events.js";
import { BUILD } from "./build-info.js";
import type { FileStore } from "./files/index.js";
import { readSettings } from "./settings.js";

/* ------------------------------------------------------------------ */
/* Settings and sign-up                                                */
/* ------------------------------------------------------------------ */

/**
 * Decides whether an email may create an account, and whether it starts
 * as an administrator: the first account, or one listed in ADMIN_EMAILS.
 */
export async function signupDecision(
  db: Database,
  email: string,
  adminEmails: string | undefined,
): Promise<{
  allowed: boolean;
  isAdmin: boolean;
  /** Why not: the sign-up policy, or an address outside the domains. */
  refusal?: "signup_closed" | "signup_domain_not_allowed";
}> {
  const existing = await db
    .selectFrom("users")
    .select("id")
    .limit(1)
    .executeTakeFirst();
  const firstAccount = !existing;
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
    return { allowed: false, isAdmin, refusal: "signup_closed" };
  }
  // The domains hold for anyone who comes on their own: an owner's
  // invitation, the operator's ADMIN_EMAILS, and the first account pass.
  if (
    !firstAccount &&
    !listedAdmin &&
    !invited &&
    !emailDomainAllowed(email, settings.signupDomains)
  ) {
    return { allowed: false, isAdmin, refusal: "signup_domain_not_allowed" };
  }
  return { allowed: true, isAdmin };
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

export async function listUsers(
  db: Database,
  input: { search?: string; offset: number; limit: number },
) {
  const pattern = input.search
    ? `%${input.search.replace(/[%_\\]/g, "\\$&")}%`
    : undefined;
  const matching = () => {
    const query = db.selectFrom("users as u");
    return pattern
      ? query.where((eb) =>
          eb.or([
            eb("u.email", "ilike", pattern),
            eb("u.displayName", "ilike", pattern),
          ]),
        )
      : query;
  };
  const rows = await matching()
    .select([
      "u.id",
      "u.email",
      "u.displayName",
      "u.isAdmin",
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
      sqlTag<boolean>`exists (select 1 from sso_identities i where i.user_id = u.id)`.as(
        "signOn",
      ),
      sqlTag<Date | null>`(select max(s.created_at) from sessions s where s.user_id = u.id)`.as(
        "lastSeen",
      ),
      sqlTag<number>`(select count(distinct b.scope_id)::int from role_bindings b where b.user_id = u.id and b.scope = 'base')`.as(
        "bases",
      ),
    ])
    .orderBy("u.createdAt", "asc")
    .offset(input.offset)
    .limit(input.limit)
    .execute();
  const total = await matching()
    .select(sqlTag<number>`count(*)::int`.as("value"))
    .executeTakeFirst();
  const policy = await readSettings(db);
  const withFactors = await Promise.all(
    rows.map(async ({ scimUserName, deprovisionedAt, lockedAt, ...row }) => ({
      ...row,
      // Locked by failed sign-ins (ADR 0043); `until: null` waits for an
      // administrator.
      lock: (() => {
        const state = lockState(lockedAt, policy, row.isAdmin);
        return state.locked
          ? { until: state.until?.toISOString() ?? null }
          : null;
      })(),
      // Kept by an identity provider (SCIM), or removed by it.
      provisioned: scimUserName !== null,
      deprovisioned: deprovisionedAt !== null,
      mfa: (await factorMethods(db, row.id)).length > 0,
      createdAt: row.createdAt.toISOString(),
      disabledAt: row.disabledAt?.toISOString() ?? null,
      lastSeen: row.lastSeen ? new Date(row.lastSeen).toISOString() : null,
    })),
  );
  return { users: withFactors, total: total?.value ?? 0 };
}

/** Disabling an account also ends its sessions; its API tokens stop working. */
export async function setUserDisabled(
  db: Database,
  actorId: string,
  userId: string,
  disabled: boolean,
): Promise<void> {
  if (actorId === userId) {
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

/** Changes the admin flag; the last active administrator cannot be removed. */
export async function setUserAdmin(
  db: Database,
  userId: string,
  admin: boolean,
): Promise<void> {
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
      .returning("id")
      .execute();
    if (updated.length === 0) throw new AppError("unknown_account");
  });
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
  const page = rows.slice(0, input.limit);
  return {
    events: page.map(({ oldValue, newValue, ...row }) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
      // Field names only: values stay in the table's own history, behind its rights.
      fields: changedKeys(oldValue, newValue),
    })),
    next:
      rows.length > input.limit
        ? (page.at(-1)?.occurredAt.toISOString() ?? null)
        : null,
  };
}
