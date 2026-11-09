/**
 * What a MySQL or MariaDB source holds, as its dedicated account sees it
 * (ADR 0006): the tables and views of its database the account may read,
 * their columns and keys, and what it may write. Read from
 * information_schema, which lists only what the account has rights on.
 */
import { checkChoices, mapMysqlType, withChoices } from "@anygriddb/core";
import type mysql from "mysql2/promise";
import { connectMysql, mysqlSourceError } from "./mysql.js";
import type { SourceConnection, SourceTable } from "./types.js";

/** Bounds on what one introspection returns. */
const MAX_TABLES = 2_000;

type TableRow = {
  schema: string;
  name: string;
  type: string;
  comment: string | null;
  estimate: string | number | null;
};

type ColumnRow = {
  table: string;
  name: string;
  type: string;
  nullable: string;
  comment: string | null;
  extra: string | null;
  privileges: string | null;
};

type KeyRow = {
  table: string;
  constraint: string;
  kind: "PRIMARY KEY" | "FOREIGN KEY";
  column: string;
  target_schema: string | null;
  target_table: string | null;
  target_column: string | null;
};

type PrivilegeRow = { privilege: string; table: string | null };

export async function introspectMysql(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceTable[]> {
  const { connection, serverVersion } = await connectMysql(source, options);
  try {
    return await readSchema(connection, /mariadb/i.test(serverVersion));
  } catch (error) {
    throw mysqlSourceError(error);
  } finally {
    await connection.end().catch(() => undefined);
  }
}

async function rows<T>(
  connection: mysql.Connection,
  statement: string,
): Promise<T[]> {
  const [result] = await connection.query<mysql.RowDataPacket[]>(statement);
  return result as T[];
}

async function readSchema(
  connection: mysql.Connection,
  mariadb: boolean,
): Promise<SourceTable[]> {
  const tables = await rows<TableRow>(
    connection,
    `select table_schema as \`schema\`, table_name as name, table_type as type,
            nullif(table_comment, '') as comment, table_rows as estimate
       from information_schema.tables
      where table_schema = database()
        and table_type in ('BASE TABLE', 'VIEW', 'SYSTEM VERSIONED')
      order by table_name
      limit ${String(MAX_TABLES)}`,
  );
  if (tables.length === 0) return [];
  const columns = await rows<ColumnRow>(
    connection,
    `select table_name as \`table\`, column_name as name, column_type as type,
            is_nullable as nullable, nullif(column_comment, '') as comment,
            extra as extra, privileges as privileges
       from information_schema.columns
      where table_schema = database()
      order by table_name, ordinal_position`,
  );
  // MariaDB hides TABLE_CONSTRAINTS from an account that only reads, but
  // shows KEY_COLUMN_USAGE: the primary key is always named PRIMARY, and
  // a foreign key names the table it references.
  const keys = await rows<KeyRow>(
    connection,
    `select table_name as \`table\`, constraint_name as \`constraint\`,
            case when constraint_name = 'PRIMARY' then 'PRIMARY KEY'
                 else 'FOREIGN KEY' end as kind,
            column_name as \`column\`,
            referenced_table_schema as target_schema,
            referenced_table_name as target_table,
            referenced_column_name as target_column
       from information_schema.key_column_usage
      where table_schema = database()
        and (constraint_name = 'PRIMARY' or referenced_table_name is not null)
      order by table_name, constraint_name, ordinal_position`,
  );
  // DELETE is granted on a table, its schema, or everything; the other
  // rights also show per column.
  const deletable = await rows<PrivilegeRow>(
    connection,
    `select privilege_type as privilege, null as \`table\`
       from information_schema.user_privileges
      where privilege_type = 'DELETE'
     union all
     select privilege_type, null from information_schema.schema_privileges
      where privilege_type = 'DELETE' and table_schema = database()
     union all
     select privilege_type, table_name from information_schema.table_privileges
      where privilege_type = 'DELETE' and table_schema = database()`,
  );
  // Checks the account may see: a list of values makes a single select
  // (`status in ('draft', 'sent')`). MariaDB names their table; MySQL
  // through TABLE_CONSTRAINTS.
  const checks = await rows<{ table: string; clause: string }>(
    connection,
    mariadb
      ? `select table_name as \`table\`, check_clause as clause
           from information_schema.check_constraints
          where constraint_schema = database()`
      : `select tc.table_name as \`table\`, cc.check_clause as clause
           from information_schema.check_constraints cc
           join information_schema.table_constraints tc
             on tc.constraint_schema = cc.constraint_schema
            and tc.constraint_name = cc.constraint_name
            and tc.constraint_type = 'CHECK'
          where cc.constraint_schema = database()`,
  );
  // MariaDB's JSON is a LONGTEXT that a check keeps valid: where the
  // account may see the check, it tells JSON apart, read-only as on
  // MySQL; elsewhere the column reads as long text.
  const json = new Set(
    mariadb
      ? checks.flatMap((row) => {
          const column = /^json_valid\(`((?:[^`]|``)+)`\)$/i.exec(
            row.clause.trim(),
          )?.[1];
          return column ? [`${row.table}.${column.replace(/``/g, "`")}`] : [];
        })
      : [],
  );
  const choicesOf = (table: string, column: string) =>
    checks
      .filter((row) => row.table === table)
      .map((row) => checkChoices(row.clause, column))
      .find((found) => found !== null) ?? null;
  const deleteAll = deletable.some((row) => row.table === null);
  const deleteOn = new Set(deletable.map((row) => row.table));

  const byTable = new Map<string, ColumnRow[]>();
  for (const column of columns) {
    byTable.set(column.table, [...(byTable.get(column.table) ?? []), column]);
  }
  const keysOf = new Map<string, Map<string, KeyRow[]>>();
  for (const key of keys) {
    const table = keysOf.get(key.table) ?? new Map<string, KeyRow[]>();
    table.set(key.constraint, [...(table.get(key.constraint) ?? []), key]);
    keysOf.set(key.table, table);
  }

  return tables.map((table) => {
    const own = (byTable.get(table.name) ?? []).filter((column) =>
      rights(column).has("select"),
    );
    const constraints = [...(keysOf.get(table.name)?.values() ?? [])];
    const primary = constraints.find(
      (parts) => parts[0]?.kind === "PRIMARY KEY",
    );
    const view = table.type === "VIEW";
    const estimate =
      view || table.estimate === null ? null : Number(table.estimate);
    return {
      schema: table.schema,
      name: table.name,
      kind: view ? ("view" as const) : ("table" as const),
      comment: view ? null : table.comment,
      estimatedRows:
        estimate !== null && Number.isFinite(estimate) ? estimate : null,
      primaryKey: primary?.map((part) => part.column) ?? [],
      privileges: {
        insert: own.some((column) => rights(column).has("insert")),
        update: own.some((column) => rights(column).has("update")),
        delete: deleteAll || deleteOn.has(table.name),
      },
      columns: own.map((column) => {
        const field = json.has(`${table.name}.${column.name}`)
          ? mapMysqlType({ type: "json" })
          : withChoices(
              mapMysqlType({ type: column.type }),
              choicesOf(table.name, column.name),
            );
        const generated = /\bGENERATED\b/i.test(column.extra ?? "");
        return {
          name: column.name,
          type: column.type,
          nullable: column.nullable === "YES",
          comment: column.comment,
          canUpdate: rights(column).has("update") && !generated,
          // AUTO_INCREMENT takes a value of ours; a generated column none.
          canInsert: !generated,
          field: generated ? { ...field, readOnly: true } : field,
        };
      }),
      foreignKeys: constraints
        .filter((parts) => parts[0]?.kind === "FOREIGN KEY")
        .map((parts) => ({
          columns: parts.map((part) => part.column),
          target: {
            schema: parts[0]?.target_schema ?? table.schema,
            name: parts[0]?.target_table ?? "",
          },
          targetColumns: parts.map((part) => part.target_column ?? ""),
        })),
    };
  });
}

/** The account's rights on a column, as information_schema lists them. */
function rights(column: ColumnRow): Set<string> {
  return new Set(
    (column.privileges ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}
