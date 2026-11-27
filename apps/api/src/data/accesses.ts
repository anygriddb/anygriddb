/**
 * Everything that reaches the instance without a session, for its
 * administrators (ADR 0131, §5): every delegated access, whatever its
 * kind, by its author, reach, end, last use and state, and a way to stop
 * it without being in its base. Metadata only: never a secret.
 *
 * A suspended access is one whose author or reach no longer lets it act:
 * the decision reads that at each use; this page says it, and the trails
 * say why (an account disabled, a role taken away, a base in the trash).
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { revokeAdminToken } from "../auth/admin-tokens.js";
import { isAdminOf } from "../auth/instance-roles.js";
import { revokeApiToken } from "../auth/tokens.js";
import { revokeScimToken } from "../scim/tokens.js";
import { readGateSettings } from "../settings.js";
import { withAudit } from "./audit-context.js";

type AccessState = "live" | "ended" | "revoked" | "suspended";

export type ListedAccess = {
  id: string;
  kind:
    | "admin_token"
    | "api_token"
    | "application"
    | "feed"
    | "inbound_hook"
    | "link"
    | "scim_token";
  name: string;
  author: string;
  authorId: string;
  /** What it reaches: a base, a table and a view, or an automation. */
  baseId: string | null;
  base: string | null;
  table: string | null;
  view: string | null;
  automation: string | null;
  /** A token's bases: how many, or null for every one of its author's. */
  bases: number | null;
  createdAt: string;
  endsAt: string | null;
  lastUsedAt: string | null;
  state: AccessState;
  /** A link that asks a password. */
  protected: boolean;
  /** A token that writes nothing. */
  readOnly: boolean;
};

/**
 * One page of the accesses, newest first: every kind, or those of one
 * base; revoked ones only when asked.
 */
export async function listAccesses(
  db: Database,
  input: {
    limit: number;
    offset?: number;
    baseId?: string;
    revoked?: boolean;
  },
): Promise<{ accesses: ListedAccess[]; total: number }> {
  const settings = await readGateSettings(db);
  const oldest = new Date(Date.now() - settings.tokenMaxDays * 86_400_000);
  const state = sql<AccessState>`case
    when a.revoked_at is not null then 'revoked'
    when a.ends_at is not null and a.ends_at <= now() then 'ended'
    when a.kind in ('api_token', 'application', 'admin_token')
      and a.created_at <= ${oldest} then 'ended'
    when u.disabled_at is not null then 'suspended'
    when a.kind in ('admin_token', 'scim_token')
      and not ${isAdminOf("u.id")} then 'suspended'
    when a.kind in ('api_token', 'application')
      and ${settings.apiTokens === "admins"} and not ${isAdminOf("u.id")}
      then 'suspended'
    when a.kind = 'link' and (${settings.publicLinks === "off"}
      or (${settings.publicLinks === "password"} and a.password_hash is null))
      then 'suspended'
    when v.deleted_at is not null or t.deleted_at is not null
      or b.deleted_at is not null then 'suspended'
    else 'live' end`;
  const query = db
    .selectFrom("delegatedAccesses as a")
    .innerJoin("users as u", "u.id", "a.authorId")
    .leftJoin("views as v", "v.id", "a.viewId")
    .leftJoin("automations as m", "m.id", "a.automationId")
    .leftJoin("dataTables as t", (join) =>
      join.on(sql<boolean>`t.id = coalesce(v.table_id, m.table_id)`),
    )
    .leftJoin("bases as b", (join) =>
      join.on(sql<boolean>`b.id = coalesce(a.base_id, t.base_id)`),
    )
    .$if(input.baseId !== undefined, (inner) =>
      inner.where("b.id", "=", input.baseId ?? ""),
    )
    .$if(input.revoked !== true, (inner) =>
      inner.where("a.revokedAt", "is", null),
    );
  const [counted, rows] = await Promise.all([
    query.select(sql<string>`count(*)`.as("value")).executeTakeFirst(),
    query
      .select([
        "a.id",
        "a.kind",
        "a.name",
        "a.authorId",
        "u.displayName as author",
        "b.id as baseId",
        "b.name as base",
        "t.name as table",
        "v.name as view",
        "m.name as automation",
        "a.baseIds",
        "a.createdAt",
        "a.endsAt",
        "a.lastUsedAt",
        "a.permissions",
        sql<boolean>`a.password_hash is not null`.as("protected"),
        state.as("state"),
      ])
      .orderBy("a.createdAt", "desc")
      .orderBy("a.id", "desc")
      .offset(input.offset ?? 0)
      .limit(input.limit)
      .execute(),
  ]);
  return {
    total: Number(counted?.value ?? 0),
    accesses: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      author: row.author,
      authorId: row.authorId,
      baseId: row.baseId,
      base: row.base,
      table: row.table,
      view: row.view,
      automation: row.automation,
      bases: Array.isArray(row.baseIds) ? row.baseIds.length : null,
      createdAt: row.createdAt.toISOString(),
      endsAt: row.endsAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      state: row.state,
      protected: row.protected,
      // An administration token's are scopes, not a base's permissions.
      readOnly:
        (row.kind === "api_token" || row.kind === "application") &&
        row.permissions !== null &&
        !row.permissions.includes("rows.write"),
    })),
  };
}

/**
 * Revokes one access for an administrator who need not be in its base:
 * each kind as its own page revokes it, on the trails under their name.
 */
export async function revokeAccess(
  db: Database,
  adminId: string,
  id: string,
): Promise<ListedAccess["kind"]> {
  const access = await db
    .selectFrom("delegatedAccesses as a")
    .leftJoin("views as v", "v.id", "a.viewId")
    .leftJoin("automations as m", "m.id", "a.automationId")
    .select([
      "a.kind",
      "a.authorId",
      sql<string | null>`coalesce(v.table_id, m.table_id)`.as("tableId"),
    ])
    .where("a.id", "=", id)
    .where("a.revokedAt", "is", null)
    .executeTakeFirst();
  if (!access) throw new AppError("no_row");
  switch (access.kind) {
    case "api_token":
    case "application":
      await revokeApiToken(db, access.authorId, id, {
        actorId: adminId,
        admin: true,
      });
      break;
    case "admin_token":
      await revokeAdminToken(db, adminId, id);
      break;
    case "scim_token":
      await revokeScimToken(db, adminId, id);
      break;
    default:
      await withAudit(
        db,
        {
          userId: adminId,
          tableId: access.tableId ?? undefined,
          source: "web",
        },
        (tx) =>
          tx
            .updateTable("delegatedAccesses")
            .set({ revokedAt: new Date() })
            .where("id", "=", id)
            .where("revokedAt", "is", null)
            .execute(),
      );
  }
  return access.kind;
}
