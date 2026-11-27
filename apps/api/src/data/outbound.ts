/**
 * What acts on the instance's bases from outside a session, and what each
 * base weighs, for an administrator: the outgoing webhooks and the
 * automations, and every base with its tables. Metadata only: never a
 * cell value, a secret, or a password. The delegated accesses themselves
 * are listed in `accesses.ts`.
 */
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { liveBase, liveTable, liveView } from "./live.js";
import { lastActivity } from "./table-activity.js";

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

/**
 * Every outgoing webhook and automation of a live table of a live base:
 * whether it is on, where a webhook sends (its host), and how it fails.
 * Each kind is paged on its own.
 */
export async function listInstanceHooks(
  db: Database,
  input: {
    webhooks: { limit: number; offset?: number };
    automations: { limit: number; offset?: number };
  },
): Promise<{
  webhooks: InstanceHook[];
  webhooksTotal: number;
  automations: InstanceHook[];
  automationsTotal: number;
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const webhooksOffset = input.webhooks.offset ?? 0;
  const automationsOffset = input.automations.offset ?? 0;
  const [webhooksTotalRow, automationsTotalRow, webhooks, automations] =
    await Promise.all([
      db
        .selectFrom("webhooks as w")
        .innerJoin("dataTables as t", "t.id", "w.tableId")
        .innerJoin("bases as b", "b.id", "t.baseId")
        .select(sql<string>`count(*)`.as("value"))
        .where(liveTable("t"))
        .where(liveBase("b"))
        .executeTakeFirst(),
      db
        .selectFrom("automations as a")
        .innerJoin("dataTables as t", "t.id", "a.tableId")
        .innerJoin("bases as b", "b.id", "t.baseId")
        .select(sql<string>`count(*)`.as("value"))
        .where(liveTable("t"))
        .where(liveBase("b"))
        .executeTakeFirst(),
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
        .offset(webhooksOffset)
        .limit(input.webhooks.limit)
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
        .offset(automationsOffset)
        .limit(input.automations.limit)
        .execute(),
    ]);
  return {
    webhooksTotal: Number(webhooksTotalRow?.value ?? 0),
    automationsTotal: Number(automationsTotalRow?.value ?? 0),
    webhooks: webhooks.map((row): InstanceHook => ({
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
    automations: automations.map((row): InstanceHook => ({
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
  };
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
  /** When one of its tables was last used, by what the trails hold. */
  lastActivityAt: string | null;
};

/**
 * An owner of base `b` who can still act: an account that is not
 * disabled, with the role itself or through a group.
 */
const LIVE_OWNER = sql<boolean>`exists (select 1 from attributions r left join group_members gm on gm.group_id = r.group_id join users u on u.id = coalesce(r.user_id, gm.user_id) where r.scope = 'base' and r.scope_id = b.id and r.role = 'owner' and (r.ends_at is null or r.ends_at > now()) and u.disabled_at is null)`;

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
    offset?: number;
    baseId?: string;
    /** Only the bases no active account owns. */
    ownerless?: boolean;
  },
): Promise<{ bases: BaseOverview[]; total: number }> {
  const offset = input.offset ?? 0;
  const pattern = input.search
    ? `%${input.search.replace(/[%_\\]/g, "\\$&")}%`
    : undefined;
  const filtered = () =>
    db
      .selectFrom("bases as b")
      .where(liveBase("b"))
      .$if(pattern !== undefined, (query) =>
        query.where("b.name", "ilike", pattern ?? ""),
      )
      .$if(input.baseId !== undefined, (query) =>
        query.where("b.id", "=", input.baseId ?? ""),
      )
      .$if(input.ownerless === true, (query) =>
        query.where(sql<boolean>`not (${LIVE_OWNER})`),
      );
  const counted = await filtered()
    .select(sql<string>`count(*)`.as("value"))
    .executeTakeFirst();
  const total = Number(counted?.value ?? 0);
  const page = await filtered()
    .select(["b.id", "b.name", "b.createdAt", LIVE_OWNER.as("hasLiveOwner")])
    .orderBy("b.name", "asc")
    .orderBy("b.id", "asc")
    .offset(offset)
    .limit(input.limit)
    .execute();
  if (page.length === 0) return { bases: [], total };
  const ids = page.map((row) => row.id);

  const [ownerRows, memberRows, tableRows, fileRows, outboundRows] =
    await Promise.all([
      db
        .selectFrom("attributions as r")
        .innerJoin("users as u", "u.id", "r.userId")
        .select(["r.scopeId as baseId", "u.displayName"])
        .where("r.scope", "=", "base")
        .where("r.scopeId", "in", ids)
        .where("r.role", "=", "owner")
        .orderBy("u.displayName", "asc")
        .execute(),
      db
        .selectFrom("attributions as r")
        .leftJoin("groupMembers as gm", "gm.groupId", "r.groupId")
        .select([
          "r.scopeId as baseId",
          sql<string>`count(distinct coalesce(r.user_id, gm.user_id))`.as(
            "members",
          ),
        ])
        .where("r.scope", "=", "base")
        .where("r.scopeId", "in", ids)
        .groupBy("r.scopeId")
        .execute(),
      sql<{
        baseId: string;
        tables: string;
        estimatedRows: string;
        lastActivityAt: Date | null;
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
               )::bigint::text as "estimatedRows",
               max(${lastActivity("t")}) as "lastActivityAt"
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
        // What a base holds: a file no cell names is not its (ADR 0136).
        .where("a.releasedAt", "is", null)
        .groupBy("t.baseId")
        .execute(),
      // A view's links and feeds, one table since ADR 0131.
      db
        .selectFrom("delegatedAccesses as s")
        .innerJoin("views as v", "v.id", "s.viewId")
        .innerJoin("dataTables as t", "t.id", "v.tableId")
        .select(["t.baseId", sql<string>`count(*)`.as("value")])
        .where("t.baseId", "in", ids)
        .where("s.kind", "in", ["link", "feed"])
        .where("s.revokedAt", "is", null)
        .where(liveView("v"))
        .where(liveTable("t"))
        .groupBy("t.baseId")
        .execute(),
    ]);

  const ownersByBase = new Map<string, string[]>();
  for (const row of ownerRows) {
    if (row.baseId === null) continue;
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
        lastActivityAt: row.lastActivityAt,
      },
    ]),
  );
  const filesByBase = new Map(
    fileRows.map((row) => [row.baseId, Number(row.fileBytes)]),
  );
  const outboundByBase = new Map<string, number>();
  for (const row of outboundRows) {
    outboundByBase.set(
      row.baseId,
      (outboundByBase.get(row.baseId) ?? 0) + Number(row.value),
    );
  }

  return {
    total,
    bases: page.map((row) => {
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
        lastActivityAt: tables?.lastActivityAt?.toISOString() ?? null,
      };
    }),
  };
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
  /** When it was last used, by what the trails hold. */
  lastActivityAt: string | null;
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
      sql<string>`(select coalesce(sum(a.size), 0) from attachments a where a.table_id = t.id and a.released_at is null)`.as(
        "fileBytes",
      ),
      lastActivity("t").as("lastActivityAt"),
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
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
  }));
}
