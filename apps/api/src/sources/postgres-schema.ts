/**
 * What a PostgreSQL source holds, as its dedicated account sees it
 * (ADR 0006): the tables and views it may read, their columns and keys,
 * and what it may write. Read from pg_catalog, never assumed.
 */
import { checkChoices, mapPostgresType, withChoices } from "@anygriddb/core";
import type pg from "pg";
import { connectPostgres, postgresSourceError } from "./postgres.js";
import type { SourceConnection, SourceTable } from "./types.js";

/** Bounds on what one introspection returns. */
const MAX_TABLES = 2_000;

type TableRow = {
  oid: number;
  schema: string;
  name: string;
  kind: string;
  estimate: string | null;
  comment: string | null;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
};

type ColumnRow = {
  table_oid: number;
  name: string;
  type: string;
  base_type: string;
  category: string;
  enum_values: string[] | null;
  check_def: string | null;
  not_null: boolean;
  generated: boolean;
  /** GENERATED ALWAYS AS IDENTITY: no value of ours without an override. */
  identity_always: boolean;
  comment: string | null;
  can_select: boolean;
  can_update: boolean;
};

type KeyRow = {
  table_oid: number;
  kind: "p" | "f";
  columns: string[];
  target_schema: string | null;
  target_name: string | null;
  target_columns: string[] | null;
};

export async function introspectPostgres(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceTable[]> {
  const { client } = await connectPostgres(source, options);
  try {
    return await readSchema(client);
  } catch (error) {
    throw postgresSourceError(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readSchema(client: pg.Client): Promise<SourceTable[]> {
  const tables = await client.query<TableRow>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name,
            c.relkind as kind,
            nullif(c.reltuples, -1)::bigint::text as estimate,
            obj_description(c.oid, 'pg_class') as comment,
            -- A right on one column is a right on the table, for that column.
            has_any_column_privilege(c.oid, 'INSERT') as can_insert,
            has_any_column_privilege(c.oid, 'UPDATE') as can_update,
            has_table_privilege(c.oid, 'DELETE') as can_delete
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f')
        and n.nspname <> 'information_schema'
        and n.nspname not like 'pg\\_%'
        and not c.relispartition
        and has_table_privilege(c.oid, 'SELECT')
      order by n.nspname, c.relname
      limit $1`,
    [MAX_TABLES],
  );
  const oids = tables.rows.map((table) => table.oid);
  if (oids.length === 0) return [];
  const columns = await client.query<ColumnRow>(
    `select a.attrelid::int as table_oid, a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type,
            format_type(base.oid, null) as base_type,
            base.typcategory as category,
            case when base.typtype = 'e' then
              (select array_agg(e.enumlabel::text order by e.enumsortorder)
                 from pg_enum e where e.enumtypid = base.oid)
            end as enum_values,
            -- A check on this column alone, which may list its values.
            (select pg_get_constraintdef(k.oid) from pg_constraint k
              where k.conrelid = a.attrelid and k.contype = 'c'
                and k.conkey = array[a.attnum]::int2[]
              order by k.conname limit 1) as check_def,
            a.attnotnull as not_null,
            a.attgenerated <> '' as generated,
            a.attidentity = 'a' as identity_always,
            col_description(a.attrelid, a.attnum) as comment,
            has_column_privilege(a.attrelid, a.attnum, 'SELECT') as can_select,
            has_column_privilege(a.attrelid, a.attnum, 'UPDATE') as can_update
       from pg_attribute a
       join pg_type t on t.oid = a.atttypid
       -- A domain reads as the type it is built on.
       join pg_type base on base.oid = case when t.typtype = 'd'
                                            then t.typbasetype else t.oid end
      where a.attrelid = any($1) and a.attnum > 0 and not a.attisdropped
      order by a.attrelid, a.attnum`,
    [oids],
  );
  const keys = await client.query<KeyRow>(
    `select k.conrelid::int as table_oid, k.contype as kind,
            array(select a.attname::text from unnest(k.conkey) with ordinality u(num, i)
                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.num
                   order by u.i) as columns,
            tn.nspname as target_schema, tc.relname as target_name,
            case when k.contype = 'f' then
              array(select a.attname::text from unnest(k.confkey) with ordinality u(num, i)
                      join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.num
                     order by u.i)
            end as target_columns
       from pg_constraint k
       left join pg_class tc on tc.oid = k.confrelid
       left join pg_namespace tn on tn.oid = tc.relnamespace
      where k.conrelid = any($1) and k.contype in ('p', 'f')`,
    [oids],
  );
  return tables.rows.map((table) => {
    const own = columns.rows.filter((column) => column.table_oid === table.oid);
    const tableKeys = keys.rows.filter((key) => key.table_oid === table.oid);
    const view = table.kind === "v" || table.kind === "m";
    return {
      schema: table.schema,
      name: table.name,
      kind: view ? "view" : "table",
      comment: table.comment,
      estimatedRows: table.estimate === null ? null : Number(table.estimate),
      primaryKey: tableKeys.find((key) => key.kind === "p")?.columns ?? [],
      privileges: {
        insert: !view && table.can_insert,
        update: !view && table.can_update,
        delete: !view && table.can_delete,
      },
      columns: own
        .filter((column) => column.can_select)
        .map((column) => ({
          name: column.name,
          type: column.type,
          nullable: !column.not_null,
          comment: column.comment,
          canUpdate: !view && column.can_update && !column.generated,
          canInsert: !column.generated && !column.identity_always,
          field: withChoices(
            mapPostgresType({
              type: column.base_type,
              category: column.category,
              enumValues: column.enum_values ?? undefined,
            }),
            checkChoices(column.check_def, column.name),
          ),
        })),
      foreignKeys: tableKeys
        .filter((key) => key.kind === "f")
        .map((key) => ({
          columns: key.columns,
          target: {
            schema: key.target_schema ?? "",
            name: key.target_name ?? "",
          },
          targetColumns: key.target_columns ?? [],
        })),
    };
  });
}
