/**
 * What the conversion to attributions (ADR 0131) will not keep exactly,
 * read with the version an operator runs before it: the cases
 * `ag_rights_review()` finds (migration 0149), with the names of whom and
 * where, a page at a time, and how many of each.
 */
import { PERMISSIONS, type Permission } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { ERASED_USER_ID } from "./erasure.js";

export const REVIEW_KINDS = [
  "manager",
  "group",
  "ruled",
  "floor",
  "base_only",
  "idle_rule",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewLine = {
  kind: ReviewKind;
  person: { id: string; name: string; email: string };
  base: { id: string; name: string; trashed: boolean };
  table: { id: string; name: string; trashed: boolean } | null;
  permissions: Permission[];
};

export type RightsReview = {
  counts: Record<ReviewKind, number>;
  total: number;
  lines: ReviewLine[];
};

function isKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

/** The permissions a line names, in the catalogue's order. */
function permissionsOf(values: readonly string[] | null): Permission[] {
  const named = new Set(values ?? []);
  return PERMISSIONS.filter((permission) => named.has(permission));
}

type Row = {
  kind: string;
  userId: string;
  personName: string;
  email: string;
  baseId: string;
  baseName: string;
  baseTrashed: boolean;
  tableId: string | null;
  tableName: string | null;
  tableTrashed: boolean | null;
  permissions: string[] | null;
};

/**
 * One page of the cases, ordered by person, base, then table, and the
 * count of each case over the whole instance. The erased account holds
 * no role, and is left out all the same.
 */
export async function listRightsReview(
  db: Database,
  page: { limit: number; offset: number },
): Promise<RightsReview> {
  const [counted, rows] = await Promise.all([
    sql<{ kind: string; count: string }>`
      select r.kind, count(*)::text as count
      from ag_rights_review() r
      where r.user_id <> ${ERASED_USER_ID}::uuid
      group by r.kind
    `.execute(db),
    sql<Row>`
      select r.kind,
        r.user_id as "userId",
        u.display_name as "personName",
        u.email,
        b.id as "baseId",
        b.name as "baseName",
        b.deleted_at is not null as "baseTrashed",
        t.id as "tableId",
        t.name as "tableName",
        t.deleted_at is not null as "tableTrashed",
        r.permissions
      from ag_rights_review() r
      join users u on u.id = r.user_id
      join bases b on b.id = r.base_id
      left join data_tables t on t.id = r.table_id
      where r.user_id <> ${ERASED_USER_ID}::uuid
      order by lower(u.display_name), u.id, lower(b.name), b.id,
        t.name nulls first, t.id nulls first,
        array_position(${sql.val([...REVIEW_KINDS])}::text[], r.kind)
      limit ${page.limit} offset ${page.offset}
    `.execute(db),
  ]);
  const counts = Object.fromEntries(
    REVIEW_KINDS.map((kind) => [kind, 0]),
  ) as Record<ReviewKind, number>;
  for (const row of counted.rows) {
    if (isKind(row.kind)) counts[row.kind] = Number(row.count);
  }
  const lines: ReviewLine[] = rows.rows.flatMap((row) =>
    isKind(row.kind)
      ? [
          {
            kind: row.kind,
            person: { id: row.userId, name: row.personName, email: row.email },
            base: {
              id: row.baseId,
              name: row.baseName,
              trashed: row.baseTrashed,
            },
            table:
              row.tableId === null
                ? null
                : {
                    id: row.tableId,
                    name: row.tableName ?? "",
                    trashed: row.tableTrashed === true,
                  },
            permissions: permissionsOf(row.permissions),
          },
        ]
      : [],
  );
  return {
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    lines,
  };
}
