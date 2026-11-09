/**
 * What a SQL Server source holds, as its dedicated account sees it
 * (ADR 0006): the tables and views of its database the account may read,
 * their columns and keys, and what it may write. Read from the catalog
 * views, which show only what the account has rights on; rights come from
 * HAS_PERMS_BY_NAME, so roles and schema grants count.
 */
import { checkChoices, mapSqlServerType, withChoices } from "@anygriddb/core";
import type { Connection } from "tedious";
import {
  connectSqlServer,
  sqlServerQuery,
  sqlServerSourceError,
} from "./sqlserver.js";
import type { SourceConnection, SourceTable } from "./types.js";

/** Bounds on what one introspection returns. */
const MAX_TABLES = 2_000;

type TableRow = {
  object_id: number;
  schema: string;
  name: string;
  type: string;
  comment: string | null;
  estimate: number | string | null;
  can_insert: unknown;
  can_update: unknown;
  can_delete: unknown;
  change_tracking: unknown;
};

type ColumnRow = {
  object_id: number;
  name: string;
  type: string;
  nullable: unknown;
  computed: unknown;
  is_identity: unknown;
  comment: string | null;
  can_select: unknown;
  can_update: unknown;
};

type KeyRow = {
  object_id: number;
  kind: "PK" | "FK";
  constraint: string;
  column: string;
  target_schema: string | null;
  target_name: string | null;
  target_column: string | null;
};

export async function introspectSqlServer(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceTable[]> {
  const { connection } = await connectSqlServer(source, options);
  try {
    return await readSchema(connection);
  } catch (error) {
    throw sqlServerSourceError(error);
  } finally {
    connection.close();
  }
}

/** `nvarchar(120)`, `decimal(14,2)`, `datetime2(3)`, `varchar(max)`: a type as written. */
const TYPE_SQL = `
  case
    when t.name in ('varchar', 'char', 'varbinary', 'binary')
      then t.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length as varchar(10)) end + ')'
    when t.name in ('nvarchar', 'nchar')
      then t.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length / 2 as varchar(10)) end + ')'
    when t.name in ('decimal', 'numeric')
      then t.name + '(' + cast(c.precision as varchar(10)) + ',' + cast(c.scale as varchar(10)) + ')'
    when t.name in ('datetime2', 'datetimeoffset', 'time')
      then t.name + '(' + cast(c.scale as varchar(10)) + ')'
    else t.name
  end`;

async function readSchema(connection: Connection): Promise<SourceTable[]> {
  const tables = (await sqlServerQuery(
    connection,
    `select top (${String(MAX_TABLES)}) o.object_id, s.name as [schema], o.name, rtrim(o.type) as type,
            cast(ep.value as nvarchar(4000)) as comment,
            (select sum(p.rows) from sys.partitions p
              where p.object_id = o.object_id and p.index_id in (0, 1)) as estimate,
            has_perms_by_name(quotename(s.name) + '.' + quotename(o.name), 'OBJECT', 'INSERT') as can_insert,
            has_perms_by_name(quotename(s.name) + '.' + quotename(o.name), 'OBJECT', 'UPDATE') as can_update,
            has_perms_by_name(quotename(s.name) + '.' + quotename(o.name), 'OBJECT', 'DELETE') as can_delete,
            case when exists (select 1 from sys.change_tracking_tables ct where ct.object_id = o.object_id)
                  and has_perms_by_name(quotename(s.name) + '.' + quotename(o.name), 'OBJECT', 'VIEW CHANGE TRACKING') = 1
                 then 1 else 0 end as change_tracking
       from sys.objects o
       join sys.schemas s on s.schema_id = o.schema_id
       left join sys.extended_properties ep
         on ep.class = 1 and ep.major_id = o.object_id and ep.minor_id = 0
        and ep.name = 'MS_Description'
      where o.type in ('U', 'V') and o.is_ms_shipped = 0
        and has_perms_by_name(quotename(s.name) + '.' + quotename(o.name), 'OBJECT', 'SELECT') = 1
      order by s.name, o.name`,
  )) as TableRow[];
  if (tables.length === 0) return [];
  const columns = (await sqlServerQuery(
    connection,
    `select c.object_id, c.name, ${TYPE_SQL} as type, c.is_nullable as nullable,
            c.is_computed as computed, c.is_identity as is_identity, cast(ep.value as nvarchar(4000)) as comment,
            has_perms_by_name(quotename(s.name) + '.' + quotename(o.name), 'OBJECT', 'SELECT', c.name, 'COLUMN') as can_select,
            has_perms_by_name(quotename(s.name) + '.' + quotename(o.name), 'OBJECT', 'UPDATE', c.name, 'COLUMN') as can_update
       from sys.columns c
       join sys.objects o on o.object_id = c.object_id
       join sys.schemas s on s.schema_id = o.schema_id
       join sys.types t on t.user_type_id = c.user_type_id
       left join sys.extended_properties ep
         on ep.class = 1 and ep.major_id = c.object_id and ep.minor_id = c.column_id
        and ep.name = 'MS_Description'
      where o.type in ('U', 'V') and o.is_ms_shipped = 0
      order by c.object_id, c.column_id`,
  )) as ColumnRow[];
  const keys = (await sqlServerQuery(
    connection,
    `select k.parent_object_id as object_id, 'PK' as kind, k.name as [constraint],
            c.name as [column], null as target_schema, null as target_name,
            null as target_column, ic.key_ordinal as position
       from sys.key_constraints k
       join sys.index_columns ic on ic.object_id = k.parent_object_id and ic.index_id = k.unique_index_id
       join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
      where k.type = 'PK'
     union all
     select f.parent_object_id, 'FK', f.name, pc.name, ts.name, tt.name, rc.name,
            fc.constraint_column_id
       from sys.foreign_keys f
       join sys.foreign_key_columns fc on fc.constraint_object_id = f.object_id
       join sys.columns pc on pc.object_id = fc.parent_object_id and pc.column_id = fc.parent_column_id
       join sys.columns rc on rc.object_id = fc.referenced_object_id and rc.column_id = fc.referenced_column_id
       join sys.objects tt on tt.object_id = f.referenced_object_id
       join sys.schemas ts on ts.schema_id = tt.schema_id
      order by object_id, [constraint], position`,
  )) as KeyRow[];

  // Checks whose text the account may see (VIEW DEFINITION): a list of
  // values makes a single select (`[status]='draft' OR [status]='sent'`).
  const checks = (await sqlServerQuery(
    connection,
    `select parent_object_id as object_id, definition
       from sys.check_constraints
      where definition is not null`,
  )) as Array<{ object_id: number; definition: string }>;
  // SQL Server stores `IN ('a', 'b', 'c')` as `[x]='c' OR [x]='b' OR
  // [x]='a'`: the list, as people wrote it, is read back to front.
  const choicesOf = (objectId: number, column: string) =>
    checks
      .filter((row) => row.object_id === objectId)
      .map((row) => checkChoices(row.definition, column)?.reverse() ?? null)
      .find((found) => found !== null) ?? null;

  const byTable = new Map<number, ColumnRow[]>();
  for (const column of columns) {
    byTable.set(column.object_id, [
      ...(byTable.get(column.object_id) ?? []),
      column,
    ]);
  }
  const keysOf = new Map<number, Map<string, KeyRow[]>>();
  for (const key of keys) {
    const table = keysOf.get(key.object_id) ?? new Map<string, KeyRow[]>();
    table.set(key.constraint, [...(table.get(key.constraint) ?? []), key]);
    keysOf.set(key.object_id, table);
  }

  return tables.map((table) => {
    const own = (byTable.get(table.object_id) ?? []).filter(
      (column) => Number(column.can_select) === 1,
    );
    const constraints = [...(keysOf.get(table.object_id)?.values() ?? [])];
    const primary = constraints.find((parts) => parts[0]?.kind === "PK");
    const view = table.type === "V";
    const estimate =
      view || table.estimate === null ? null : Number(table.estimate);
    return {
      schema: table.schema,
      name: table.name,
      kind: view ? ("view" as const) : ("table" as const),
      comment: table.comment,
      estimatedRows:
        estimate !== null && Number.isFinite(estimate) ? estimate : null,
      primaryKey: primary?.map((part) => part.column) ?? [],
      privileges: {
        insert: Number(table.can_insert) === 1,
        update:
          Number(table.can_update) === 1 ||
          own.some((column) => Number(column.can_update) === 1),
        delete: Number(table.can_delete) === 1,
      },
      // Enabled by the DBA, and readable by the account (ADR 0031).
      changeTracking: Number(table.change_tracking) === 1,
      columns: own.map((column) => {
        const field = withChoices(
          mapSqlServerType({ type: column.type }),
          choicesOf(table.object_id, column.name),
        );
        return {
          name: column.name,
          type: column.type,
          nullable: Boolean(column.nullable),
          comment: column.comment,
          canUpdate:
            Number(column.can_update) === 1 && column.computed !== true,
          // SQL Server fills an identity, a computed column, and a
          // rowversion itself, and refuses a value of ours (error 544).
          canInsert:
            column.computed !== true &&
            column.is_identity !== true &&
            !/^(rowversion|timestamp)$/i.test(column.type),
          field:
            column.computed === true ? { ...field, readOnly: true } : field,
        };
      }),
      foreignKeys: constraints
        .filter((parts) => parts[0]?.kind === "FK")
        .map((parts) => ({
          columns: parts.map((part) => part.column),
          target: {
            schema: parts[0]?.target_schema ?? table.schema,
            name: parts[0]?.target_name ?? "",
          },
          targetColumns: parts.map((part) => part.target_column ?? ""),
        })),
    };
  });
}
