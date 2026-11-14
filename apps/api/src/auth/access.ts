import {
  type Action,
  AppError,
  type Binding,
  can,
  enrollmentGate,
  roleFor,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { readGateSettings } from "../settings.js";
import { findSessionUser, type SessionUser } from "./session.js";
import { findApiToken, type TokenScope } from "./tokens.js";
import { sessionBindings } from "../data/emergency-access.js";
import { liveBase, liveTable } from "../data/live.js";

export type FactorMethod = "totp" | "webauthn";
export type GridDecision = "ok" | "denied" | "enroll";

export async function loadBindings(
  db: Database,
  userId: string,
): Promise<Binding[]> {
  return db
    .selectFrom("roleBindings")
    .select(["role", "scope", "scopeId"])
    .where("userId", "=", userId)
    .execute();
}

/** The second factors an account has set up, read in one query. */
export async function factorMethods(
  db: Database,
  userId: string,
): Promise<FactorMethod[]> {
  const found = await db
    .selectNoFrom((eb) => [
      eb
        .exists(
          eb
            .selectFrom("totpSecrets")
            .select("userId")
            .where("userId", "=", userId)
            .where("confirmedAt", "is not", null),
        )
        .as("totp"),
      eb
        .exists(
          eb
            .selectFrom("webauthnCredentials")
            .select("id")
            .where("userId", "=", userId),
        )
        .as("webauthn"),
    ])
    .executeTakeFirst();
  const methods: FactorMethod[] = [];
  if (found?.totp) {
    methods.push("totp");
  }
  if (found?.webauthn) {
    methods.push("webauthn");
  }
  return methods;
}

/**
 * Whether the policy wants this account to confirm a second factor before
 * working (ADR 0043). With `ssoMfa: "provider"`, an account that signs in
 * only through the identity provider counts as enrolled: its provider
 * asked for the second factor.
 */
export async function mfaGate(
  db: Database,
  user: { id: string; isAdmin: boolean },
  bindings: readonly Binding[],
  creatingBase = false,
): Promise<"ok" | "enroll"> {
  const policy = await readGateSettings(db);
  const factors = (await factorMethods(db, user.id)).length;
  const providerFactor =
    factors === 0 &&
    policy.ssoMfa === "provider" &&
    !(await db
      .selectFrom("passwordHashes")
      .select("userId")
      .where("userId", "=", user.id)
      .executeTakeFirst());
  return enrollmentGate({
    bindings,
    factors,
    creatingBase,
    isAdmin: user.isAdmin,
    scope: policy.mfaScope,
    providerFactor,
  });
}

export async function assertEnrolled(
  db: Database,
  user: { id: string; isAdmin: boolean },
  bindings: readonly Binding[],
  creatingBase = false,
): Promise<void> {
  if ((await mfaGate(db, user, bindings, creatingBase)) === "enroll") {
    throw new AppError("mfa_enrollment_required");
  }
}

/** During maintenance only administrators work (ADR 0042). */
export async function assertNotInMaintenance(
  db: Database,
  user: SessionUser,
): Promise<void> {
  if (!user.isAdmin && (await readGateSettings(db)).maintenance) {
    throw new AppError("instance_maintenance");
  }
}

/**
 * Socket channels are table ids (rows) or base ids (catalog changes). A
 * table uses its effective role; a base admits anyone with a role on it or
 * on one of its tables.
 */
export async function authorizeGrid(
  db: Database,
  userId: string,
  channel: string,
  action: Action,
): Promise<GridDecision> {
  const raw = await loadBindings(db, userId);
  const account = await db
    .selectFrom("users")
    .select(["id", "isAdmin"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!account) return "denied";
  if ((await mfaGate(db, account, raw)) === "enroll") {
    return "enroll";
  }
  // A socket is a person's own session: it follows the bases they have
  // open as an administrator, as their pages do.
  const bindings = await sessionBindings(db, account, raw);
  if (!/^[0-9a-f-]{36}$/i.test(channel)) {
    return "denied";
  }
  // A user's own channel carries their notifications; nobody else may listen.
  if (channel.toLowerCase() === userId.toLowerCase()) {
    return action === "read" ? "ok" : "denied";
  }
  const table = await db
    .selectFrom("dataTables as t")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .select(["t.id", "t.baseId"])
    .where("t.id", "=", channel)
    .where(liveTable("t"))
    .where(liveBase("b"))
    .executeTakeFirst();
  if (table) {
    return can(bindings, action, "table", table.id, table.baseId)
      ? "ok"
      : "denied";
  }
  if (action !== "read") {
    return "denied";
  }
  if (roleFor(bindings, "base", channel)) {
    return "ok";
  }
  const inBase = await db
    .selectFrom("dataTables")
    .select("id")
    .where("baseId", "=", channel)
    .execute();
  return inBase.some((row) => roleFor(bindings, "table", row.id))
    ? "ok"
    : "denied";
}

/**
 * Narrows bindings to what an API token allows: its bases only, and
 * viewer rights when it is read-only. Session requests pass through.
 */
export async function scopeBindings(
  db: Database,
  bindings: readonly Binding[],
  scope: TokenScope | undefined,
): Promise<Binding[]> {
  if (!scope) {
    return [...bindings];
  }
  let list = [...bindings];
  if (scope.baseIds) {
    const allowed = new Set(scope.baseIds);
    const tableIds = list
      .filter((binding) => binding.scope === "table")
      .map((binding) => binding.scopeId);
    const baseOfTable = new Map(
      tableIds.length === 0
        ? []
        : (
            await db
              .selectFrom("dataTables")
              .select(["id", "baseId"])
              .where("id", "in", tableIds)
              .execute()
          ).map((row) => [row.id, row.baseId] as const),
    );
    list = list.filter((binding) =>
      binding.scope === "base"
        ? allowed.has(binding.scopeId)
        : binding.scope === "table"
          ? allowed.has(baseOfTable.get(binding.scopeId) ?? "")
          : false,
    );
  }
  if (scope.readOnly) {
    list = list.map((binding) => ({ ...binding, role: "viewer" as const }));
  }
  return list;
}

/** User and effective bindings of a plain HTTP request (cookie or bearer token), MFA gate included. */
export async function requestActor(
  db: Database,
  headers: { authorization?: string },
  cookie: string | undefined,
): Promise<{
  user: SessionUser;
  bindings: Binding[];
  scope?: TokenScope;
} | null> {
  const bearer = await findApiToken(db, headers.authorization);
  const user = bearer?.user ?? (await findSessionUser(db, cookie));
  if (!user) {
    return null;
  }
  await assertNotInMaintenance(db, user);
  const raw = await loadBindings(db, user.id);
  await assertEnrolled(db, user, raw);
  // As in `authorize`: the session reads the bases its administrator has
  // open, a token does not.
  const own = bearer ? raw : await sessionBindings(db, user, raw);
  return {
    user,
    bindings: await scopeBindings(db, own, bearer?.scope),
    scope: bearer?.scope,
  };
}
