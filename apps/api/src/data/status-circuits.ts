import {
  AppError,
  assertCircuitEdit,
  type StatusCircuit,
  type StatusState,
  type StatusTransition,
  type TransitionSignature,
} from "@anygriddb/core";
import { type Database, type Tx } from "@anygriddb/db";
import { sql } from "kysely";
import { withAudit } from "./audit-context.js";

type Db = Database | Tx;

function asSignature(value: string): TransitionSignature {
  if (value === "password" || value === "step_up" || value === "none") {
    return value;
  }
  return "none";
}

async function loadCircuitById(
  db: Db,
  circuitId: string,
): Promise<StatusCircuit> {
  const circuit = await db
    .selectFrom("statusCircuits")
    .selectAll()
    .where("id", "=", circuitId)
    .executeTakeFirst();
  if (!circuit) {
    throw new AppError("no_row");
  }
  const states = await db
    .selectFrom("statusStates")
    .selectAll()
    .where("circuitId", "=", circuitId)
    .orderBy("position")
    .orderBy("key")
    .execute();
  const transitions = await db
    .selectFrom("statusTransitions")
    .selectAll()
    .where("circuitId", "=", circuitId)
    .orderBy("position")
    .orderBy("key")
    .execute();
  const grants =
    transitions.length === 0
      ? []
      : await db
          .selectFrom("statusTransitionGrants")
          .selectAll()
          .where(
            "transitionId",
            "in",
            transitions.map((item) => item.id),
          )
          .execute();
  const byTransition = new Map<string, { roles: string[]; made: string[] }>();
  for (const grant of grants) {
    const given = byTransition.get(grant.transitionId) ?? {
      roles: [],
      made: [],
    };
    if (grant.roleKey !== null) given.roles.push(grant.roleKey);
    if (grant.madeRoleId !== null) given.made.push(grant.madeRoleId);
    byTransition.set(grant.transitionId, given);
  }
  const stateKey = new Map(states.map((item) => [item.id, item.key]));
  return {
    id: circuit.id,
    key: circuit.key,
    name: circuit.name,
    system: circuit.system,
    tableId: circuit.tableId,
    states: states.map((item): StatusState => ({
      id: item.id,
      key: item.key,
      label: item.label,
      isInitial: item.isInitial,
      rowWritable: item.rowWritable,
      writableFields: item.writableFields,
      allowDelete: item.allowDelete,
      seal: item.seal,
      position: item.position,
    })),
    transitions: transitions.map((item): StatusTransition => {
      const fromStateKey = stateKey.get(item.fromStateId);
      const toStateKey = stateKey.get(item.toStateId);
      if (!fromStateKey || !toStateKey) {
        throw new AppError("invalid_status");
      }
      return {
        id: item.id,
        key: item.key,
        label: item.label,
        fromStateKey,
        toStateKey,
        requireReason: item.requireReason,
        requireFields: [...item.requireFields],
        signature: asSignature(item.signature),
        fourEyes: item.fourEyes,
        position: item.position,
        roleKeys: byTransition.get(item.id)?.roles ?? [],
        madeRoleIds: byTransition.get(item.id)?.made ?? [],
      };
    }),
  };
}

/** The circuit owned by a table, or a shipped template when `tableId` is null. */
export async function loadTableCircuit(
  db: Db,
  tableId: string,
): Promise<StatusCircuit> {
  const row = await db
    .selectFrom("statusCircuits")
    .select("id")
    .where("tableId", "=", tableId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return loadCircuitById(db, row.id);
}

/**
 * The state keys and step keys of each table's circuit, in two reads for
 * any number of tables: what the API's document names. A table with no
 * circuit of its own follows compliance, as the database does.
 */
export async function circuitKeysOf(
  db: Db,
  tableIds: readonly string[],
): Promise<Map<string, { states: string[]; steps: string[] }>> {
  const keys = new Map<string, { states: string[]; steps: string[] }>();
  if (tableIds.length === 0) return keys;
  const circuits = await db
    .selectFrom("statusCircuits")
    .select(["id", "tableId"])
    .where((eb) =>
      eb.or([
        eb("tableId", "in", [...tableIds]),
        eb.and([eb("tableId", "is", null), eb("key", "=", "compliance")]),
      ]),
    )
    .execute();
  const ids = circuits.map((circuit) => circuit.id);
  const [states, steps] = await Promise.all([
    db
      .selectFrom("statusStates")
      .select(["circuitId", "key"])
      .where("circuitId", "in", ids)
      .orderBy("position")
      .orderBy("key")
      .execute(),
    db
      .selectFrom("statusTransitions")
      .select(["circuitId", "key"])
      .where("circuitId", "in", ids)
      .orderBy("position")
      .orderBy("key")
      .execute(),
  ]);
  const of = (circuitId: string) => ({
    states: states
      .filter((state) => state.circuitId === circuitId)
      .map((state) => state.key),
    steps: [
      ...new Set(
        steps
          .filter((step) => step.circuitId === circuitId)
          .map((step) => step.key),
      ),
    ],
  });
  const shipped = circuits.find((circuit) => circuit.tableId === null);
  for (const tableId of tableIds) {
    const own = circuits.find((circuit) => circuit.tableId === tableId);
    const circuit = own ?? shipped;
    if (circuit) keys.set(tableId, of(circuit.id));
  }
  return keys;
}

export async function listCircuitTemplates(db: Db): Promise<StatusCircuit[]> {
  const rows = await db
    .selectFrom("statusCircuits")
    .select("id")
    .where("tableId", "is", null)
    .where("system", "=", true)
    .orderBy("key")
    .execute();
  const out: StatusCircuit[] = [];
  for (const row of rows) {
    out.push(await loadCircuitById(db, row.id));
  }
  return out;
}

/**
 * Replace the table's circuit with a duplicate of a shipped template.
 * Rows whose status key is missing from the new circuit need `remap`. The
 * database's owner does the change (`ag_replace_status_circuit`): it keeps
 * a sealed row sealed and writes the change, and each row moved, on the
 * trail. What is checked here first only says what is wrong in words.
 */
export async function applyCircuitTemplate(
  db: Database,
  input: {
    userId: string;
    tableId: string;
    templateKey: string;
    remap?: Record<string, string>;
    physicalName: string;
    storage: "native" | "external";
  },
): Promise<StatusCircuit> {
  // A client's table keeps its statuses beside its rows in the compliance
  // circuit's words (ADR 0033): another circuit's states would not be read.
  if (input.storage === "external" && input.templateKey !== "compliance") {
    throw new AppError("circuit_fixed_on_source");
  }
  const template = await db
    .selectFrom("statusCircuits")
    .select("id")
    .where("tableId", "is", null)
    .where("key", "=", input.templateKey)
    .executeTakeFirst();
  if (!template) {
    throw new AppError("no_row");
  }

  return withAudit(
    db,
    { userId: input.userId, tableId: input.tableId, source: "web" },
    async (tx) => {
      const current = await loadTableCircuit(tx, input.tableId);
      const nextStates = await tx
        .selectFrom("statusStates")
        .select(["key", "isInitial"])
        .where("circuitId", "=", template.id)
        .execute();
      const remainingKeys = nextStates.map((item) => item.key);
      const initial = nextStates.find((item) => item.isInitial)?.key;
      if (!initial) {
        throw new AppError("invalid_status");
      }
      const counts = await statusCounts(tx, input);
      const removedKeys = current.states
        .map((item) => item.key)
        .filter((key) => !remainingKeys.includes(key));
      const remap = input.remap ?? {};
      assertCircuitEdit({
        remainingStateKeys: remainingKeys,
        initialKey: initial,
        rowStatusCounts: counts,
        removedKeys,
        remap,
      });
      await sql`
        select ag_replace_status_circuit(
          ${input.tableId}::uuid,
          ${input.templateKey},
          ${JSON.stringify(remap)}::jsonb
        )
      `.execute(tx);
      return loadTableCircuit(tx, input.tableId);
    },
  );
}

/** How many rows of the table each status holds. */
async function statusCounts(
  db: Db,
  input: {
    tableId: string;
    physicalName: string;
    storage: "native" | "external";
  },
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (input.storage === "native") {
    const rows = await sql<{ status: string; n: string }>`
      select "ag_status" as status, count(*)::text as n
        from ${sql.table(input.physicalName)}
       group by "ag_status"
    `.execute(db);
    for (const row of rows.rows) {
      counts[row.status] = Number(row.n);
    }
    return counts;
  }
  const rows = await db
    .selectFrom("externalStatuses")
    .select(["status", sql<string>`count(*)::text`.as("n")])
    .where("tableId", "=", input.tableId)
    .groupBy("status")
    .execute();
  for (const row of rows) {
    counts[row.status] = Number(row.n);
  }
  // Draft is the absence of a row; always covered by the initial key.
  return counts;
}
