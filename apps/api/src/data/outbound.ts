/**
 * What lets a view be read from outside its base, across the instance:
 * public links and private calendar feeds. Metadata only, for an
 * administrator: never a cell value, a token, or a password.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { withAudit } from "./audit-context.js";
import { liveBase, liveTable, liveView } from "./live.js";

type OutboundLink = {
  kind: "link" | "feed";
  id: string;
  baseId: string;
  base: string;
  table: string;
  view: string;
  author: string;
  createdAt: string;
  /** A public link's end, if it has one. */
  expiresAt: string | null;
  expired: boolean;
  /** A public link asks for a password. */
  protected: boolean;
  /** When a calendar feed was last read; a link's use is not recorded. */
  lastUsedAt: string | null;
};

/**
 * Every public link not revoked, and every calendar feed, of a live view
 * of a live table of a live base: newest first, at most `limit` of each.
 */
export async function listOutbound(
  db: Database,
  limit: number,
  /** Only those of this base. */
  baseId?: string,
): Promise<OutboundLink[]> {
  const now = Date.now();
  const [links, feeds] = await Promise.all([
    db
      .selectFrom("shares as s")
      .innerJoin("users as u", "u.id", "s.createdBy")
      .innerJoin("views as v", "v.id", "s.viewId")
      .innerJoin("dataTables as t", "t.id", "v.tableId")
      .innerJoin("bases as b", "b.id", "t.baseId")
      .select([
        "s.id",
        "s.createdAt",
        "s.expiresAt",
        "s.passwordHash",
        "u.displayName as author",
        "v.name as view",
        "t.name as table",
        "b.id as baseId",
        "b.name as base",
      ])
      .where("s.revokedAt", "is", null)
      .where(liveView("v"))
      .where(liveTable("t"))
      .where(liveBase("b"))
      .$if(baseId !== undefined, (query) =>
        query.where("b.id", "=", baseId ?? ""),
      )
      .orderBy("s.createdAt", "desc")
      .limit(limit)
      .execute(),
    db
      .selectFrom("calendarFeeds as f")
      .innerJoin("users as u", "u.id", "f.userId")
      .innerJoin("views as v", "v.id", "f.viewId")
      .innerJoin("dataTables as t", "t.id", "v.tableId")
      .innerJoin("bases as b", "b.id", "t.baseId")
      .select([
        "f.id",
        "f.createdAt",
        "f.lastUsedAt",
        "u.displayName as author",
        "v.name as view",
        "t.name as table",
        "b.id as baseId",
        "b.name as base",
      ])
      .where(liveView("v"))
      .where(liveTable("t"))
      .where(liveBase("b"))
      .$if(baseId !== undefined, (query) =>
        query.where("b.id", "=", baseId ?? ""),
      )
      .orderBy("f.createdAt", "desc")
      .limit(limit)
      .execute(),
  ]);
  return [
    ...links.map((row): OutboundLink => ({
      kind: "link",
      id: row.id,
      baseId: row.baseId,
      base: row.base,
      table: row.table,
      view: row.view,
      author: row.author,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
      protected: row.passwordHash !== null,
      lastUsedAt: null,
    })),
    ...feeds.map((row): OutboundLink => ({
      kind: "feed",
      id: row.id,
      baseId: row.baseId,
      base: row.base,
      table: row.table,
      view: row.view,
      author: row.author,
      createdAt: row.createdAt.toISOString(),
      expiresAt: null,
      expired: false,
      protected: false,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Revokes a public link, or removes a calendar feed, for an administrator
 * who need not be a member of its base. A feed's removal is on the change
 * trail under their name, as its owner's would be.
 */
export async function revokeOutbound(
  db: Database,
  adminId: string,
  target: { kind: "link" | "feed"; id: string },
): Promise<void> {
  if (target.kind === "link") {
    const row = await db
      .updateTable("shares")
      .set({ revokedAt: new Date() })
      .where("id", "=", target.id)
      .where("revokedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) throw new AppError("no_row");
    return;
  }
  const feed = await db
    .selectFrom("calendarFeeds as f")
    .innerJoin("views as v", "v.id", "f.viewId")
    .select(["f.id", "v.tableId"])
    .where("f.id", "=", target.id)
    .executeTakeFirst();
  if (!feed) throw new AppError("no_row");
  await withAudit(
    db,
    { userId: adminId, tableId: feed.tableId, source: "web" },
    (tx) => tx.deleteFrom("calendarFeeds").where("id", "=", feed.id).execute(),
  );
}

type InstanceToken = {
  id: string;
  name: string;
  ownerId: string;
  owner: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  lastUsedAt: string | null;
  readOnly: boolean;
  /** How many bases it is limited to; null when it reaches all of its owner's. */
  bases: number | null;
};

type InstanceHook = {
  kind: "webhook" | "automation";
  id: string;
  name: string;
  baseId: string;
  base: string;
  table: string;
  owner: string | null;
  on: boolean;
  /** Where a webhook sends, its host only: a path may carry a secret. */
  host: string | null;
  /** Why a webhook was turned off, when the instance did it. */
  reason: string | null;
  lastRunAt: string | null;
  /** Webhook: failures in a row. Automation: failed runs in 24 hours. */
  failures: number;
};

function hostOf(target: string): string | null {
  if (target.startsWith("mailto:") || target.includes("@")) return null;
  try {
    return new URL(target).host;
  } catch {
    return null;
  }
}

/** Every API token of the instance, with its owner and last use. */
export async function listInstanceTokens(
  db: Database,
  limit: number,
): Promise<InstanceToken[]> {
  const now = Date.now();
  const rows = await db
    .selectFrom("apiTokens as k")
    .innerJoin("users as u", "u.id", "k.userId")
    .select([
      "k.id",
      "k.name",
      "k.userId",
      "k.createdAt",
      "k.expiresAt",
      "k.lastUsedAt",
      "k.readOnly",
      "k.baseIds",
      "u.displayName as owner",
    ])
    .orderBy("k.createdAt", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.userId,
    owner: row.owner,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= now,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    readOnly: row.readOnly,
    bases: Array.isArray(row.baseIds) ? row.baseIds.length : null,
  }));
}

/**
 * Every outgoing webhook and automation of a live table of a live base:
 * whether it is on, where a webhook sends (its host), and how it fails.
 */
export async function listInstanceHooks(
  db: Database,
  limit: number,
): Promise<InstanceHook[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [webhooks, automations] = await Promise.all([
    db
      .selectFrom("webhooks as w")
      .innerJoin("dataTables as t", "t.id", "w.tableId")
      .innerJoin("bases as b", "b.id", "t.baseId")
      .leftJoin("users as u", "u.id", "w.createdBy")
      .select([
        "w.id",
        "w.name",
        "w.active",
        "w.target",
        "w.disabledReason",
        "w.failureCount",
        "t.name as table",
        "b.id as baseId",
        "b.name as base",
        "u.displayName as owner",
      ])
      .where(liveTable("t"))
      .where(liveBase("b"))
      .orderBy("w.createdAt", "desc")
      .limit(limit)
      .execute(),
    db
      .selectFrom("automations as a")
      .innerJoin("dataTables as t", "t.id", "a.tableId")
      .innerJoin("bases as b", "b.id", "t.baseId")
      .leftJoin("users as u", "u.id", "a.createdBy")
      .select((eb) => [
        "a.id",
        "a.name",
        "a.enabled",
        "a.lastRunAt",
        "t.name as table",
        "b.id as baseId",
        "b.name as base",
        "u.displayName as owner",
        eb
          .selectFrom("automationRuns as r")
          .select((inner) => inner.fn.countAll<string>().as("count"))
          .whereRef("r.automationId", "=", "a.id")
          .where("r.status", "=", "failed")
          .where("r.startedAt", ">=", since)
          .as("failures"),
      ])
      .where(liveTable("t"))
      .where(liveBase("b"))
      .orderBy("a.createdAt", "desc")
      .limit(limit)
      .execute(),
  ]);
  return [
    ...webhooks.map((row): InstanceHook => ({
      kind: "webhook",
      id: row.id,
      name: row.name,
      baseId: row.baseId,
      base: row.base,
      table: row.table,
      owner: row.owner,
      on: row.active,
      host: hostOf(row.target),
      reason: row.disabledReason,
      lastRunAt: null,
      failures: row.failureCount,
    })),
    ...automations.map((row): InstanceHook => ({
      kind: "automation",
      id: row.id,
      name: row.name,
      baseId: row.baseId,
      base: row.base,
      table: row.table,
      owner: row.owner,
      on: row.enabled,
      host: null,
      reason: null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      failures: Number(row.failures ?? 0),
    })),
  ];
}

type BaseOverview = {
  id: string;
  name: string;
  createdAt: string;
  /** Up to three owners with a role of their own, by name. */
  owners: string[];
  /** An account that is not disabled owns it, itself or through a group. */
  hasLiveOwner: boolean;
  members: number;
  tables: number;
  /** AnyGridDB's own tables, from PostgreSQL's statistics: an estimate. */
  estimatedRows: number;
  /** The base's files, in bytes. */
  fileBytes: number;
  /** Public links and calendar feeds of its views. */
  outbound: number;
};

/**
 * An owner of base `b` who can still act: an account that is not
 * disabled, with the role itself or through a group.
 */
const LIVE_OWNER = sql<boolean>`exists (select 1 from role_bindings r join users u on u.id = r.user_id where r.scope = 'base' and r.scope_id = b.id and r.role = 'owner' and u.disabled_at is null)`;

/**
 * Every live base of the instance with what an administrator weighs it
 * by, metadata only. Row counts come from the statistics, never from a
 * count. The page of bases is read first; their weights are aggregated
 * once for those ids, not with a subquery per base.
 */
export async function listBaseOverview(
  db: Database,
  input: {
    search?: string;
    limit: number;
    baseId?: string;
    /** Only the bases no active account owns. */
    ownerless?: boolean;
  },
): Promise<BaseOverview[]> {
  const pattern = input.search
    ? `%${input.search.replace(/[%_\\]/g, "\\$&")}%`
    : undefined;
  const page = await db
    .selectFrom("bases as b")
    .select(["b.id", "b.name", "b.createdAt", LIVE_OWNER.as("hasLiveOwner")])
    .where(liveBase("b"))
    .$if(pattern !== undefined, (query) =>
      query.where("b.name", "ilike", pattern ?? ""),
    )
    .$if(input.baseId !== undefined, (query) =>
      query.where("b.id", "=", input.baseId ?? ""),
    )
    .$if(input.ownerless === true, (query) =>
      query.where(sql<boolean>`not (${LIVE_OWNER})`),
    )
    .orderBy("b.name", "asc")
    .orderBy("b.id", "asc")
    .limit(input.limit)
    .execute();
  if (page.length === 0) return [];
  const ids = page.map((row) => row.id);

  const [ownerRows, memberRows, tableRows, fileRows, shareRows, feedRows] =
    await Promise.all([
      db
        .selectFrom("roleBindings as r")
        .innerJoin("users as u", "u.id", "r.userId")
        .select(["r.scopeId as baseId", "u.displayName"])
        .where("r.scope", "=", "base")
        .where("r.scopeId", "in", ids)
        .where("r.role", "=", "owner")
        .where("r.groupId", "is", null)
        .orderBy("u.displayName", "asc")
        .execute(),
      db
        .selectFrom("roleBindings as r")
        .select([
          "r.scopeId as baseId",
          sql<string>`count(distinct r.user_id)`.as("members"),
        ])
        .where("r.scope", "=", "base")
        .where("r.scopeId", "in", ids)
        .groupBy("r.scopeId")
        .execute(),
      sql<{
        baseId: string;
        tables: string;
        estimatedRows: string;
      }>`
        select t.base_id as "baseId",
               count(*)::text as tables,
               coalesce(
                 sum(
                   case
                     when t.source_id is null then greatest(c.reltuples, 0)
                     else 0
                   end
                 ),
                 0
               )::bigint::text as "estimatedRows"
          from data_tables t
          left join pg_class c
            on c.oid = to_regclass(quote_ident(t.physical_name))
         where t.base_id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
           and t.deleted_at is null
         group by t.base_id
      `
        .execute(db)
        .then((result) => result.rows),
      db
        .selectFrom("attachments as a")
        .innerJoin("dataTables as t", "t.id", "a.tableId")
        .select([
          "t.baseId",
          sql<string>`coalesce(sum(a.size), 0)`.as("fileBytes"),
        ])
        .where("t.baseId", "in", ids)
        .groupBy("t.baseId")
        .execute(),
      db
        .selectFrom("shares as s")
        .innerJoin("views as v", "v.id", "s.viewId")
        .innerJoin("dataTables as t", "t.id", "v.tableId")
        .select(["t.baseId", sql<string>`count(*)`.as("value")])
        .where("t.baseId", "in", ids)
        .where("s.revokedAt", "is", null)
        .where(liveView("v"))
        .where(liveTable("t"))
        .groupBy("t.baseId")
        .execute(),
      db
        .selectFrom("calendarFeeds as f")
        .innerJoin("views as v", "v.id", "f.viewId")
        .innerJoin("dataTables as t", "t.id", "v.tableId")
        .select(["t.baseId", sql<string>`count(*)`.as("value")])
        .where("t.baseId", "in", ids)
        .where(liveView("v"))
        .where(liveTable("t"))
        .groupBy("t.baseId")
        .execute(),
    ]);

  const ownersByBase = new Map<string, string[]>();
  for (const row of ownerRows) {
    const names = ownersByBase.get(row.baseId) ?? [];
    if (names.length < 3) names.push(row.displayName);
    ownersByBase.set(row.baseId, names);
  }
  const membersByBase = new Map(
    memberRows.map((row) => [row.baseId, Number(row.members)]),
  );
  const tablesByBase = new Map(
    tableRows.map((row) => [
      row.baseId,
      {
        tables: Number(row.tables),
        estimatedRows: Number(row.estimatedRows),
      },
    ]),
  );
  const filesByBase = new Map(
    fileRows.map((row) => [row.baseId, Number(row.fileBytes)]),
  );
  const outboundByBase = new Map<string, number>();
  for (const row of [...shareRows, ...feedRows]) {
    outboundByBase.set(
      row.baseId,
      (outboundByBase.get(row.baseId) ?? 0) + Number(row.value),
    );
  }

  return page.map((row) => {
    const tables = tablesByBase.get(row.id);
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      owners: ownersByBase.get(row.id) ?? [],
      hasLiveOwner: row.hasLiveOwner,
      members: membersByBase.get(row.id) ?? 0,
      tables: tables?.tables ?? 0,
      estimatedRows: tables?.estimatedRows ?? 0,
      fileBytes: filesByBase.get(row.id) ?? 0,
      outbound: outboundByBase.get(row.id) ?? 0,
    };
  });
}

/** How many live bases no active account owns. */
export async function countOwnerlessBases(db: Database): Promise<number> {
  const row = await db
    .selectFrom("bases as b")
    .select(sql<number>`count(*)::int`.as("value"))
    .where(liveBase("b"))
    .where(sql<boolean>`not (${LIVE_OWNER})`)
    .executeTakeFirst();
  return row?.value ?? 0;
}

type BaseTableOverview = {
  id: string;
  name: string;
  /** Where its rows live: AnyGridDB's database, or a client's. */
  external: boolean;
  /** AnyGridDB's own tables only; a client's database counts its own. */
  estimatedRows: number | null;
  fileBytes: number;
};

/** A base's live tables, by their place, with their weight. */
export async function listBaseTables(
  db: Database,
  baseId: string,
): Promise<BaseTableOverview[]> {
  const rows = await db
    .selectFrom("dataTables as t")
    .select([
      "t.id",
      "t.name",
      "t.sourceId",
      sql<
        string | null
      >`(select greatest(c.reltuples, 0)::bigint from pg_class c where c.oid = to_regclass(quote_ident(t.physical_name)) and t.source_id is null)`.as(
        "estimatedRows",
      ),
      sql<string>`(select coalesce(sum(a.size), 0) from attachments a where a.table_id = t.id)`.as(
        "fileBytes",
      ),
    ])
    .where("t.baseId", "=", baseId)
    .where(liveTable("t"))
    .orderBy("t.position", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    external: row.sourceId !== null,
    estimatedRows:
      row.estimatedRows === null ? null : Number(row.estimatedRows),
    fileBytes: Number(row.fileBytes),
  }));
}
