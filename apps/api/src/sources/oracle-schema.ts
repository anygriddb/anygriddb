/**
 * What an Oracle source holds, as its dedicated account sees it (ADR 0006):
 * the tables and views of every schema it may read (its own, and those
 * granted to it, its roles, or PUBLIC), their columns and keys, and what
 * it may write. Schemas Oracle maintains are left out.
 */
import { checkChoices, mapOracleType, withChoices } from "@anygriddb/core";
import type { Connection } from "oracledb";
import {
  connectOracle,
  oracleQuery,
  oracleSourceError,
  rowValue,
  type OracleRow,
} from "./oracle.js";
import type { SourceConnection, SourceTable } from "./types.js";

/** Bounds on what one introspection returns. */
const MAX_TABLES = 2_000;

/**
 * The objects the account reads: its own, and those granted SELECT or
 * READ to it, a role it holds, or PUBLIC. `grants` lists, per object,
 * what it may do beyond reading.
 */
const OBJECTS = `
  with grants as (
    select p.table_schema as owner, p.table_name as name, p.privilege
      from all_tab_privs p
     where p.grantee in (
             sys_context('USERENV', 'SESSION_USER'), 'PUBLIC'
           )
        or p.grantee in (select role from session_roles)
  ),
  objects as (
    select t.owner, t.table_name as name, 'TABLE' as kind, t.num_rows
      from all_tables t
     where t.secondary = 'N' and t.nested = 'NO' and t.iot_type is null
       and t.temporary = 'N'
    union all
    select v.owner, v.view_name, 'VIEW', null from all_views v
  )
  select o.owner as "owner", o.name as "name", o.kind as "kind",
         o.num_rows as "rows", c.comments as "comment"
    from objects o
    join all_users u on u.username = o.owner and u.oracle_maintained = 'N'
    left join all_tab_comments c on c.owner = o.owner and c.table_name = o.name
   where o.owner = sys_context('USERENV', 'SESSION_USER')
      or exists (
           select 1 from grants g
            where g.owner = o.owner and g.name = o.name
              and g.privilege in ('SELECT', 'READ')
         )
   order by o.owner, o.name
   fetch first ${String(MAX_TABLES)} rows only`;

/** A type as written: `number(14,2)`, `varchar2(120)`, `timestamp(6)`. */
function typeLabel(row: OracleRow): string {
  const type = text(row, "data_type").toLowerCase();
  if (type === "number") {
    const precision = text(row, "data_precision");
    const scale = text(row, "data_scale");
    if (precision === "") return "number";
    return scale === "" || scale === "0"
      ? `number(${precision})`
      : `number(${precision},${scale})`;
  }
  if (["varchar2", "nvarchar2", "char", "nchar"].includes(type)) {
    return `${type}(${text(row, "char_length")})`;
  }
  // TIMESTAMP(6) WITH TIME ZONE: the data type says its precision.
  return type;
}

function text(row: OracleRow, key: string): string {
  const value = rowValue(row, key);
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function grouped(rows: OracleRow[]): Map<string, OracleRow[]> {
  const byObject = new Map<string, OracleRow[]>();
  for (const row of rows) {
    const key = `${text(row, "owner")}.${text(row, "table_name")}`;
    byObject.set(key, [...(byObject.get(key) ?? []), row]);
  }
  return byObject;
}

export async function introspectOracle(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceTable[]> {
  const { connection } = await connectOracle(source, options);
  try {
    return await readSchema(connection);
  } catch (error) {
    throw oracleSourceError(error);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function readSchema(connection: Connection): Promise<SourceTable[]> {
  const objects = await oracleQuery(connection, OBJECTS);
  if (objects.length === 0) return [];
  const listed = `select o."owner", o."name" from (${OBJECTS}) o`;
  const [columns, constraints, checks, comments, rights, updatable] =
    await Promise.all([
      oracleQuery(
        connection,
        `select c.owner as "owner", c.table_name as "table_name",
                c.column_name as "name", c.data_type as "data_type",
                c.data_precision as "data_precision",
                c.data_scale as "data_scale", c.char_length as "char_length",
                c.nullable as "nullable", c.virtual_column as "virtual",
                i.generation_type as "identity"
           from all_tab_cols c
           join (${listed}) l on l."owner" = c.owner and l."name" = c.table_name
           left join all_tab_identity_cols i
             on i.owner = c.owner and i.table_name = c.table_name
            and i.column_name = c.column_name
          where c.hidden_column = 'NO' and c.user_generated = 'YES'
          order by c.owner, c.table_name, c.column_id`,
      ),
      oracleQuery(
        connection,
        `select k.owner as "owner", k.table_name as "table_name",
                k.constraint_type as "kind", k.constraint_name as "constraint",
                kc.column_name as "column", r.owner as "target_owner",
                r.table_name as "target_table", rc.column_name as "target_column"
           from all_constraints k
           join (${listed}) l on l."owner" = k.owner and l."name" = k.table_name
           join all_cons_columns kc
             on kc.owner = k.owner and kc.constraint_name = k.constraint_name
           left join all_constraints r
             on r.owner = k.r_owner and r.constraint_name = k.r_constraint_name
           left join all_cons_columns rc
             on rc.owner = r.owner and rc.constraint_name = r.constraint_name
            and rc.position = kc.position
          where k.constraint_type in ('P', 'R')
          order by k.owner, k.table_name, k.constraint_name, kc.position`,
      ),
      oracleQuery(
        connection,
        `select k.owner as "owner", k.table_name as "table_name",
                k.search_condition_vc as "definition"
           from all_constraints k
           join (${listed}) l on l."owner" = k.owner and l."name" = k.table_name
          where k.constraint_type = 'C' and k.search_condition_vc is not null`,
      ),
      oracleQuery(
        connection,
        `select c.owner as "owner", c.table_name as "table_name",
                c.column_name as "column", c.comments as "comment"
           from all_col_comments c
           join (${listed}) l on l."owner" = c.owner and l."name" = c.table_name
          where c.comments is not null`,
      ),
      // What the account may change: its own objects, object grants, and
      // grants of single columns.
      oracleQuery(
        connection,
        `select p.table_schema as "owner", p.table_name as "table_name",
                null as "column", p.privilege as "privilege"
           from all_tab_privs p
          where (p.grantee in (sys_context('USERENV', 'SESSION_USER'), 'PUBLIC')
                 or p.grantee in (select role from session_roles))
            and p.privilege in ('INSERT', 'UPDATE', 'DELETE')
         union all
         select p.table_schema, p.table_name, p.column_name, p.privilege
           from all_col_privs p
          where (p.grantee in (sys_context('USERENV', 'SESSION_USER'), 'PUBLIC')
                 or p.grantee in (select role from session_roles))
            and p.privilege in ('INSERT', 'UPDATE')`,
      ),
      // Views: which of their columns Oracle can write through.
      oracleQuery(
        connection,
        `select u.owner as "owner", u.table_name as "table_name",
                u.column_name as "column", u.updatable as "updatable",
                u.insertable as "insertable", u.deletable as "deletable"
           from all_updatable_columns u
           join (${listed}) l on l."owner" = u.owner and l."name" = u.table_name
           join all_views v on v.owner = u.owner and v.view_name = u.table_name`,
      ),
    ]);
  const [session] = await oracleQuery(
    connection,
    `select sys_context('USERENV', 'SESSION_USER') as "user" from dual`,
  );
  const self = text(session ?? {}, "user");
  const columnsOf = grouped(columns);
  const constraintsOf = grouped(constraints);
  const checksOf = grouped(checks);
  const commentsOf = grouped(comments);
  const rightsOf = grouped(rights);
  const viewColumnsOf = grouped(updatable);

  return objects.map((object): SourceTable => {
    const schema = text(object, "owner");
    const name = text(object, "name");
    const key = `${schema}.${name}`;
    const view = text(object, "kind") === "VIEW";
    const owned = schema === self;
    const granted = (privilege: string, column?: string) =>
      owned ||
      (rightsOf.get(key) ?? []).some(
        (right) =>
          text(right, "privilege") === privilege &&
          (rowValue(right, "column") === null ||
            (column !== undefined && text(right, "column") === column)),
      );
    const through = (column: string, flag: string) =>
      !view ||
      (viewColumnsOf.get(key) ?? []).some(
        (item) => text(item, "column") === column && text(item, flag) === "YES",
      );
    const byConstraint = new Map<string, OracleRow[]>();
    for (const row of constraintsOf.get(key) ?? []) {
      const constraint = text(row, "constraint");
      byConstraint.set(constraint, [
        ...(byConstraint.get(constraint) ?? []),
        row,
      ]);
    }
    const parts = [...byConstraint.values()];
    const primary = parts.find((rows) => text(rows[0] ?? {}, "kind") === "P");
    const definitions = (checksOf.get(key) ?? []).map((row) =>
      text(row, "definition"),
    );
    const commentOf = new Map(
      (commentsOf.get(key) ?? []).map((row) => [
        text(row, "column"),
        text(row, "comment"),
      ]),
    );
    const own = columnsOf.get(key) ?? [];
    const deletable =
      granted("DELETE") &&
      (!view ||
        (viewColumnsOf.get(key) ?? []).some(
          (item) => text(item, "deletable") === "YES",
        ));
    const tableComment = text(object, "comment");
    const rows = Number(rowValue(object, "rows"));
    return {
      schema,
      name,
      kind: view ? "view" : "table",
      comment: tableComment || null,
      estimatedRows:
        Number.isFinite(rows) && rowValue(object, "rows") !== null
          ? rows
          : null,
      primaryKey: primary?.map((row) => text(row, "column")) ?? [],
      privileges: {
        insert:
          granted("INSERT") ||
          own.some((c) => granted("INSERT", text(c, "name"))),
        update:
          granted("UPDATE") ||
          own.some((c) => granted("UPDATE", text(c, "name"))),
        delete: deletable,
      },
      changeTracking: false,
      columns: own.map((column) => {
        const columnName = text(column, "name");
        const type = typeLabel(column);
        const field = withChoices(
          mapOracleType({ type }),
          definitions
            .map((definition) => checkChoices(definition, columnName))
            .find((found) => found !== null) ?? null,
        );
        const computed = text(column, "virtual") === "YES";
        const writable = !field.readOnly && !computed;
        return {
          name: columnName,
          type,
          nullable: text(column, "nullable") === "Y",
          comment: commentOf.get(columnName) || null,
          canUpdate:
            writable &&
            granted("UPDATE", columnName) &&
            through(columnName, "updatable"),
          canInsert:
            writable &&
            text(column, "identity") !== "ALWAYS" &&
            granted("INSERT", columnName) &&
            through(columnName, "insertable"),
          field,
        };
      }),
      foreignKeys: parts
        .filter((rows) => text(rows[0] ?? {}, "kind") === "R")
        .map((rows) => ({
          columns: rows.map((row) => text(row, "column")),
          target: {
            schema: text(rows[0] ?? {}, "target_owner"),
            name: text(rows[0] ?? {}, "target_table"),
          },
          targetColumns: rows.map((row) => text(row, "target_column")),
        })),
    };
  });
}
