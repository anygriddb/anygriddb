/**
 * Tables and views a SQLite file exposes, from sqlite_master and PRAGMA
 * table_info. Schema is always `main` (attached DBs are out of scope).
 */
import { mapSqliteType } from "@anygriddb/core";
import type { SqlitePathAccess } from "./sqlite-path.js";
import { connectSqlite, sqliteSourceError } from "./sqlite.js";
import type { SourceConnection, SourceTable } from "./types.js";

const MAX_TABLES = 2_000;

type MasterRow = { name: string; kind: string };

type InfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

type FkRow = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
};

export function introspectSqlite(
  source: SourceConnection,
  access: SqlitePathAccess,
): Promise<SourceTable[]> {
  const { db } = connectSqlite(source, access);
  try {
    const masters = db
      .prepare(
        `select name as name,
                case type when 'view' then 'view' else 'table' end as kind
           from sqlite_master
          where type in ('table', 'view')
            and name not like 'sqlite_%'
          order by name
          limit ?`,
      )
      .all(MAX_TABLES) as MasterRow[];

    const tables: SourceTable[] = [];
    for (const master of masters) {
      const info = db
        .prepare(`pragma table_info(${quoteIdent(master.name)})`)
        .all() as InfoRow[];
      const fks = db
        .prepare(`pragma foreign_key_list(${quoteIdent(master.name)})`)
        .all() as FkRow[];
      const primaryKey = info
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      const fkGroups = new Map<number, FkRow[]>();
      for (const row of fks) {
        const group = fkGroups.get(row.id) ?? [];
        group.push(row);
        fkGroups.set(row.id, group);
      }
      tables.push({
        schema: "main",
        name: master.name,
        kind: master.kind === "view" ? "view" : "table",
        comment: null,
        estimatedRows: null,
        primaryKey,
        privileges: {
          insert: master.kind !== "view",
          update: master.kind !== "view",
          delete: master.kind !== "view",
        },
        columns: info.map((column) => {
          const field = mapSqliteType({ type: column.type || "TEXT" });
          return {
            name: column.name,
            type: column.type || "TEXT",
            nullable: column.notnull === 0,
            comment: null,
            canUpdate: master.kind !== "view",
            canInsert: master.kind !== "view",
            field,
          };
        }),
        foreignKeys: [...fkGroups.values()].map((group) => {
          const ordered = [...group].sort((a, b) => a.seq - b.seq);
          return {
            columns: ordered.map((row) => row.from),
            target: { schema: "main", name: ordered[0]?.table ?? "" },
            targetColumns: ordered.map((row) => row.to),
          };
        }),
      });
    }
    return Promise.resolve(tables);
  } catch (error) {
    throw sqliteSourceError(error);
  } finally {
    db.close();
  }
}

/** Double-quote an identifier for PRAGMA table_info("name"). */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
