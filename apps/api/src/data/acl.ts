import { createHash } from "node:crypto";
import { rulesOwner } from "./acting-context.js";
import {
  aclSubjectOf,
  AppError,
  type AclSubject,
  effectiveTableRole,
  roleGrants,
  tableRules,
  type Binding,
  type ColumnAclEntry,
  type EngineAccess,
  type EngineCatalog,
  type FilterGroup,
  type TableAcl,
  type TableRules,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { holderOf, liveAttribution } from "./attributions.js";
import { withAudit, type AuditTx } from "./audit-context.js";
import { fieldsOf, givenOf, MADE_COLUMNS, rowsOf } from "./made-roles.js";
import { liveColumnNames } from "./live.js";
import {
  assembleEngine,
  indexCatalog,
  loadCatalogRows,
  loadEngine,
  type CatalogIndex,
  type CatalogRows,
} from "./engine.js";

/** Where a subject's attribution is kept: its column, and the id there. */
function subjectColumn(
  subject: AclSubject,
): ["userId", string] | ["groupId", string] {
  return "userId" in subject
    ? ["userId", subject.userId]
    : ["groupId", subject.groupId];
}

/**
 * The rules on a table (ADR 0131): each role given on the table, to a
 * person or to a group, that narrows what it gives, to some rows and
 * field by field.
 */
export async function listTableAcls(
  db: Database,
  tableId: string,
): Promise<TableAcl[]> {
  const rows = await db
    .selectFrom("attributions")
    .select(["userId", "groupId", "rowFilter", "fieldAccess"])
    .where("scope", "=", "table")
    .where("scopeId", "=", tableId)
    .where((eb) =>
      eb.or([
        eb("rowFilter", "is not", null),
        eb("fieldAccess", "is not", null),
      ]),
    )
    .execute();
  return rows.flatMap((row) => {
    const subject: AclSubject | null =
      row.userId !== null
        ? { userId: row.userId }
        : row.groupId !== null
          ? { groupId: row.groupId }
          : null;
    if (!subject) return [];
    return [
      {
        ...subject,
        rowFilter: rowsOf(row.rowFilter),
        columns: Object.entries(fieldsOf(row.fieldAccess) ?? {}).map(
          ([column, access]) => ({ column, access }),
        ),
      },
    ];
  });
}

/**
 * A rule narrows only the role it comes with: its subject must hold a role
 * given on this table, and nothing on its base that would give them the
 * table whole. For a person, that is their own role on the base or one a
 * group gives them; for a group, its own. A group's rule binds each member
 * who holds nothing wider: what reaches them otherwise adds to it.
 */
async function assertRuleNarrows(
  tx: AuditTx,
  table: { id: string; baseId: string },
  subject: AclSubject,
): Promise<void> {
  const reached = await tx
    .selectFrom("attributions as a")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select(["a.scope", "a.userId", "a.groupId", "a.role", ...MADE_COLUMNS])
    .where((eb) =>
      "userId" in subject
        ? holderOf(eb, subject.userId)
        : eb("a.groupId", "=", subject.groupId),
    )
    .where((eb) =>
      eb.or([
        eb.and([eb("a.scope", "=", "table"), eb("a.scopeId", "=", table.id)]),
        eb.and([
          eb("a.scope", "=", "base"),
          eb("a.scopeId", "=", table.baseId),
        ]),
      ]),
    )
    .where(liveAttribution)
    .execute();
  const [column, id] = subjectColumn(subject);
  const own = reached.find(
    (row) => row.scope === "table" && row[column] === id,
  );
  if (!own || reached.some((row) => row.scope === "base")) {
    throw new AppError("rule_needs_table_role");
  }
  // Whoever manages the table sets its rules, and none binds them.
  if (roleGrants(givenOf(own), "members.manage")) {
    throw new AppError("rule_binds_no_manager");
  }
}

/** Replaces one person's or one group's rules on a table, audited under the manager. */
export async function setTableAcl(
  db: Database,
  actorId: string,
  input: AclSubject & {
    tableId: string;
    rowFilter: FilterGroup | null;
    columns: readonly ColumnAclEntry[];
  },
): Promise<void> {
  const subject = aclSubjectOf(input);
  await withAudit(
    db,
    { userId: actorId, tableId: input.tableId, source: "web" },
    async (tx) => {
      const table = await tx
        .selectFrom("dataTables")
        .select(["id", "baseId"])
        .where("id", "=", input.tableId)
        .executeTakeFirstOrThrow();
      await assertRuleNarrows(tx, table, subject);
      const [column, id] = subjectColumn(subject);
      await tx
        .updateTable("attributions")
        .set({
          rowFilter: input.rowFilter,
          fieldAccess:
            input.columns.length === 0
              ? null
              : Object.fromEntries(
                  input.columns.map((entry) => [entry.column, entry.access]),
                ),
        })
        .where(column, "=", id)
        .where("scope", "=", "table")
        .where("scopeId", "=", input.tableId)
        .execute();
    },
  );
}

/** Takes away one person's or one group's rules on a table: the role there stays. */
export async function clearTableAcl(
  db: Database,
  actorId: string,
  tableId: string,
  subject: AclSubject,
): Promise<void> {
  const [column, id] = subjectColumn(subject);
  await withAudit(
    db,
    { userId: actorId, tableId, source: "web" },
    async (tx) => {
      await tx
        .updateTable("attributions")
        .set({ rowFilter: null, fieldAccess: null })
        .where(column, "=", id)
        .where("scope", "=", "table")
        .where("scopeId", "=", tableId)
        .execute();
    },
  );
}

/** Who reads: the account and its roles, which decide the rules that apply. */
type Reader = { userId: string; bindings: readonly Binding[] };

/** Which tables a reader may read: the engine hides the linked ones they may not. */
export function readableTables(
  bindings: readonly Binding[],
  baseOf: ReadonlyMap<string, string>,
): (tableId: string) => boolean {
  return (tableId) =>
    roleGrants(
      effectiveTableRole(bindings, tableId, baseOf.get(tableId)),
      "rows.read",
    );
}

/**
 * The reader's field and row rules over `tables`, or undefined when none
 * applies: what the attributions that reach each table narrow (ADR 0131).
 * Rows are read through the attributions that give reading, and changed
 * through those that give the act (`rowFilter(table, act)`).
 */
export function readerAccess(
  reader: Reader,
  tables: ReadonlyArray<{ id: string; baseId: string }>,
): EngineAccess | undefined {
  const rules = new Map<string, TableRules>();
  for (const table of tables) {
    const held = tableRules(reader.bindings, table.id, table.baseId);
    if (held) rules.set(table.id, held);
  }
  if (rules.size === 0) return undefined;
  return {
    hidden: (tableId, column) => rules.get(tableId)?.access(column) === "hide",
    readOnly: (tableId, column) =>
      rules.get(tableId)?.access(column) === "read",
    rowFilter: (tableId, act = "rows.read") => rules.get(tableId)?.rows(act),
    me: rulesOwner(reader.userId),
  };
}

/**
 * A print of what a reader's rules leave them of a table and the tables it
 * links to, or null when no rule holds: two prints differ when a file
 * written under one may hold what the other hides. Which fields may be
 * written does not count, since a file only shows them.
 */
export async function readerRulesPrint(
  db: Database,
  reader: Reader,
  tableId: string,
): Promise<string | null> {
  const { tables: live, columns } = await loadCatalogRows(db, [tableId]);
  // A table in the trash is out of the catalog and still under its rules.
  const tables =
    live.length > 0
      ? live
      : await db
          .selectFrom("dataTables")
          .select(["id", "baseId"])
          .where("id", "=", tableId)
          .execute();
  const held = tables
    .map((table) => {
      const rules = tableRules(reader.bindings, table.id, table.baseId);
      const readable = roleGrants(
        effectiveTableRole(reader.bindings, table.id, table.baseId),
        "rows.read",
      );
      const names = columns
        .filter((column) => column.tableId === table.id)
        .map((column) => column.name);
      return {
        table: table.id,
        readable,
        rows: rules?.rows("rows.read") ?? null,
        fields:
          rules?.narrows === true
            ? names
                .filter((name) => rules.access(name) !== "hide")
                .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            : null,
      };
    })
    .filter((rule) => !rule.readable || rule.rows || rule.fields)
    .sort((a, b) => (a.table < b.table ? -1 : 1));
  if (held.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(held)).digest("hex");
}

/**
 * The fields of a table hidden from this reader, by name: none for whoever
 * owns the table or has no rule on it.
 */
export async function hiddenColumnNames(
  db: Database,
  reader: Reader,
  table: { id: string; baseId: string },
): Promise<ReadonlySet<string>> {
  const access = readerAccess(reader, [table]);
  if (!access) return new Set();
  const names = await liveColumnNames(db, table.id);
  return new Set([...names].filter((name) => access.hidden(table.id, name)));
}

/**
 * The read engine for one reader: tables they cannot read compile to
 * empty, and their field and row rules apply to every table it reads.
 * Every read on behalf of a person goes through here.
 */
export async function readerEngine(
  db: Database,
  tableId: string,
  reader: Reader,
): Promise<{ engine: EngineCatalog; rows: CatalogRows }> {
  const loaded = await loadEngine(db, tableId, () => true);
  const baseOf = new Map(
    loaded.rows.tables.map((table) => [table.id, table.baseId]),
  );
  const access = readerAccess(reader, loaded.rows.tables);
  return {
    engine: {
      ...loaded.engine,
      readable: readableTables(reader.bindings, baseOf),
      ...(access ? { access } : {}),
    },
    rows: loaded.rows,
  };
}

/**
 * The read engines of several tables for one reader, from one read of the
 * catalog and of the reader's rules: what `readerEngine` gives for each
 * table, without the reads it makes for each. For a page that describes
 * many tables at once; a read of rows asks for its own table.
 */
export async function readerEngines(
  db: Database,
  tableIds: readonly string[],
  reader: Reader,
): Promise<{
  engineOf: (tableId: string) => EngineCatalog;
  rows: CatalogRows;
  index: CatalogIndex;
}> {
  const rows = await loadCatalogRows(db, tableIds);
  const index = indexCatalog(rows);
  const baseOf = new Map(rows.tables.map((table) => [table.id, table.baseId]));
  const access = readerAccess(reader, rows.tables);
  const readable = readableTables(reader.bindings, baseOf);
  return {
    engineOf: (tableId) => ({
      ...assembleEngine(tableId, rows, () => true, index),
      readable,
      ...(access ? { access } : {}),
    }),
    rows,
    index,
  };
}
