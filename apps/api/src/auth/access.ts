import {
  type Action,
  AppError,
  type Binding,
  can,
  effectiveTableRole,
  enrollmentGate,
  roleFor,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { readGateSettings } from "../settings.js";
import type { Acting } from "../data/acting-context.js";
import {
  findSessionUser,
  type SessionUser,
  withActingRights,
} from "./session.js";
import { findApiToken, namesApiToken, type TokenScope } from "./tokens.js";
import {
  openBasesOf,
  sessionBindings,
  withOpenBases,
} from "../data/emergency-access.js";
import { liveBase, liveTable } from "../data/live.js";

export type FactorMethod = "totp" | "webauthn" | "email";
type GridDecision = "ok" | "denied" | "enroll";

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

/**
 * The second factors an account has, read in one query: what its sign-in
 * asks for, and what the policy counts. A code by email (ADR 0085) is one
 * for anyone but an administrator: the mailbox it reaches is the one a
 * password is reset from, and an administrator's second factor has to be
 * something that mailbox does not hold. An administrator who chose it
 * before becoming one keeps it, unused, until they are one no longer.
 * It stays listed while mail is down: the second step is never skipped.
 */
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
      eb
        .exists(
          eb
            .selectFrom("emailFactors")
            .innerJoin("users", "users.id", "emailFactors.userId")
            .select("emailFactors.userId")
            .where("emailFactors.userId", "=", userId)
            .where("users.isAdmin", "=", false),
        )
        .as("email"),
    ])
    .executeTakeFirst();
  const methods: FactorMethod[] = [];
  if (found?.totp) {
    methods.push("totp");
  }
  if (found?.webauthn) {
    methods.push("webauthn");
  }
  if (found?.email) {
    methods.push("email");
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
 * What a socket may hear of a channel it may read: `rows`, which rows moved;
 * `changes`, only that something did. A row rule or a hidden field leaves a
 * reader `changes`, since a row's id or a field's name would say what the
 * rule keeps from them. A channel that is no table carries no row.
 */
export type ChannelHearing = "rows" | "changes";

const CHANNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who, of these accounts, the policy asks to enrol a second factor first. */
async function accountsToEnrol(
  db: Database,
  accounts: ReadonlyArray<{ id: string; isAdmin: boolean }>,
  bindingsOf: ReadonlyMap<string, readonly Binding[]>,
): Promise<Set<string>> {
  const ids = accounts.map((account) => account.id);
  const policy = await readGateSettings(db);
  const [totp, webauthn, email, passwords] = await Promise.all([
    db
      .selectFrom("totpSecrets")
      .select("userId")
      .where("userId", "in", ids)
      .where("confirmedAt", "is not", null)
      .execute(),
    db
      .selectFrom("webauthnCredentials")
      .select("userId")
      .where("userId", "in", ids)
      .execute(),
    db
      .selectFrom("emailFactors")
      .innerJoin("users", "users.id", "emailFactors.userId")
      .select("emailFactors.userId")
      .where("emailFactors.userId", "in", ids)
      .where("users.isAdmin", "=", false)
      .execute(),
    policy.ssoMfa === "provider"
      ? db
          .selectFrom("passwordHashes")
          .select("userId")
          .where("userId", "in", ids)
          .execute()
      : Promise.resolve([]),
  ]);
  const enrolled = new Set(
    [...totp, ...webauthn, ...email].map((row) => row.userId),
  );
  const withPassword = new Set(passwords.map((row) => row.userId));
  const refused = new Set<string>();
  for (const account of accounts) {
    const factors = enrolled.has(account.id) ? 1 : 0;
    const gate = enrollmentGate({
      bindings: bindingsOf.get(account.id) ?? [],
      factors,
      isAdmin: account.isAdmin,
      scope: policy.mfaScope,
      providerFactor:
        factors === 0 &&
        policy.ssoMfa === "provider" &&
        !withPassword.has(account.id),
    });
    if (gate === "enroll") refused.add(account.id);
  }
  return refused;
}

/**
 * For each account, the channels it may read now and what it hears of each:
 * what `authorizeGrid` answers for a read, for many sockets at once, in the
 * same few questions however many there are. A channel left out is refused.
 */
export async function gridChannelRights(
  db: Database,
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Map<string, Map<string, ChannelHearing>>> {
  const answers = new Map<string, Map<string, ChannelHearing>>();
  const userIds = [...wanted.keys()];
  if (userIds.length === 0) return answers;
  const channels = [
    ...new Set(
      [...wanted.values()].flatMap((held) =>
        [...held]
          .filter((channel) => CHANNEL_ID.test(channel))
          .map((channel) => channel.toLowerCase()),
      ),
    ),
  ];
  const [accounts, bindings, tables, inBases] = await Promise.all([
    db
      .selectFrom("users")
      .select(["id", "isAdmin"])
      .where("id", "in", userIds)
      .execute(),
    db
      .selectFrom("roleBindings")
      .select(["userId", "role", "scope", "scopeId"])
      .where("userId", "in", userIds)
      .execute(),
    channels.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("dataTables as t")
          .innerJoin("bases as b", "b.id", "t.baseId")
          .select(["t.id", "t.baseId"])
          .where("t.id", "in", channels)
          .where(liveTable("t"))
          .where(liveBase("b"))
          .execute(),
    channels.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("dataTables")
          .select(["id", "baseId"])
          .where("baseId", "in", channels)
          .execute(),
  ]);
  if (accounts.length === 0) return answers;
  const held = new Map<string, Binding[]>();
  for (const { userId, role, scope, scopeId } of bindings) {
    const list = held.get(userId) ?? [];
    list.push({ role, scope, scopeId });
    held.set(userId, list);
  }
  const tableIds = tables.map((table) => table.id);
  const [refused, open, rowRules, fieldRules] = await Promise.all([
    accountsToEnrol(db, accounts, held),
    openBasesOf(
      db,
      accounts.filter((account) => account.isAdmin).map(({ id }) => id),
    ),
    tableIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("tableAcls")
          .select(["userId", "tableId", "rowFilter"])
          .where("userId", "in", userIds)
          .where("tableId", "in", tableIds)
          .execute(),
    tableIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("columnAcls")
          .select(["userId", "tableId"])
          .distinct()
          .where("userId", "in", userIds)
          .where("tableId", "in", tableIds)
          .execute(),
  ]);
  const baseOf = new Map(tables.map((table) => [table.id, table.baseId]));
  const ruled = new Set([
    ...rowRules
      .filter((rule) => rule.rowFilter)
      .map((rule) => `${rule.userId}:${rule.tableId}`),
    ...fieldRules.map((rule) => `${rule.userId}:${rule.tableId}`),
  ]);
  const tablesOfBase = new Map<string, string[]>();
  for (const { id, baseId } of inBases) {
    tablesOfBase.set(baseId, [...(tablesOfBase.get(baseId) ?? []), id]);
  }
  for (const account of accounts) {
    const heard = new Map<string, ChannelHearing>();
    answers.set(account.id, heard);
    if (refused.has(account.id)) continue;
    const own = withOpenBases(
      held.get(account.id) ?? [],
      open.get(account.id) ?? [],
    );
    for (const asked of wanted.get(account.id) ?? []) {
      if (!CHANNEL_ID.test(asked)) continue;
      const channel = asked.toLowerCase();
      if (channel === account.id.toLowerCase()) {
        heard.set(asked, "changes");
        continue;
      }
      const baseId = baseOf.get(channel);
      if (baseId !== undefined) {
        if (!can(own, "read", "table", channel, baseId)) continue;
        const owner = effectiveTableRole(own, channel, baseId) === "owner";
        heard.set(
          asked,
          owner || !ruled.has(`${account.id}:${channel}`) ? "rows" : "changes",
        );
        continue;
      }
      if (
        roleFor(own, "base", channel) ||
        (tablesOfBase.get(channel) ?? []).some((id) =>
          roleFor(own, "table", id),
        )
      ) {
        heard.set(asked, "changes");
      }
    }
  }
  return answers;
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

/** Who a request acts as: a session may, an API token never does (ADR 0091). */
export async function actingOf(
  db: Database,
  authorization: string | undefined,
  cookie: string | undefined,
): Promise<Acting | null> {
  if (namesApiToken(authorization)) return null;
  const user = await findSessionUser(db, cookie);
  return user?.actingAs
    ? { actorId: user.id, personId: user.actingAs.id }
    : null;
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
  if (!bearer && namesApiToken(headers.authorization)) return null;
  const user = bearer?.user ?? (await findSessionUser(db, cookie));
  if (!user) {
    return null;
  }
  await assertNotInMaintenance(db, user);
  const raw = await loadBindings(db, user.actingAs?.id ?? user.id);
  await assertEnrolled(db, user, raw);
  // As in `authorize`: the session reads the bases its administrator has
  // open, a token does not.
  const own = bearer
    ? raw
    : await sessionBindings(
        db,
        user.actingAs ? { id: user.actingAs.id, isAdmin: false } : user,
        raw,
      );
  return {
    user: withActingRights(user),
    bindings: await scopeBindings(db, own, bearer?.scope),
    scope: bearer?.scope,
  };
}
