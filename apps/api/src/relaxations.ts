/**
 * What an administrator relaxed (ADR 0140): one table, read by every gate
 * of a requirement that may be relaxed, changed in one place, each change
 * written to the sign-in trail.
 */
import {
  RELAXATIONS,
  relaxationKeySchema,
  type RelaxationKey,
  type RelaxationTarget,
} from "@anygriddb/core";
import type { Database, DB } from "@anygriddb/db";
import type { ExpressionBuilder } from "kysely";
import { recordAuthEvent, type AuthMethod } from "./auth/auth-events.js";

/** Whether `key` is relaxed: for the instance, or for the source named. */
export async function relaxationAllows(
  db: Database,
  key: RelaxationKey,
  sourceId?: string,
): Promise<boolean> {
  const query = db
    .selectFrom("relaxations")
    .select("id")
    .where("key", "=", key);
  const row = await (
    sourceId === undefined
      ? query.where("sourceId", "is", null)
      : query.where("sourceId", "=", sourceId)
  ).executeTakeFirst();
  return row !== undefined;
}

/**
 * Whether a source connects without TLS, as a column of a read of
 * `sources` (`allowPlaintext`): its relaxation, read with the row.
 */
export function plaintextColumn(eb: ExpressionBuilder<DB, "sources">) {
  return eb
    .exists(
      eb
        .selectFrom("relaxations")
        .select("relaxations.id")
        .whereRef("relaxations.sourceId", "=", "sources.id")
        .where("relaxations.key", "=", "source.plaintext"),
    )
    .$castTo<boolean>()
    .as("allowPlaintext");
}

/** Who relaxes, or goes back to strict, as the sign-in trail says it. */
type RelaxationActor = {
  id: string;
  ip?: string | undefined;
  method?: AuthMethod;
};

/**
 * Relaxes a requirement, or takes its relaxation away, and says whether
 * that changed anything: the trails are written only then. Run it under
 * an audit context (`withAudit`), in the transaction of what it goes with
 * when there is one (a source saved): the change trail keeps the row.
 */
export async function setRelaxation(
  db: Database,
  actor: RelaxationActor,
  target: RelaxationTarget,
  on: boolean,
): Promise<boolean> {
  const sourceId = target.sourceId ?? null;
  let changed: boolean;
  if (on) {
    const added = await db
      .insertInto("relaxations")
      .values({
        key: target.key,
        sourceId,
        consequence: RELAXATIONS[target.key].consequence,
        enabledBy: actor.id,
      })
      .onConflict((conflict) =>
        conflict.columns(["key", "sourceId"]).doNothing(),
      )
      .returning("id")
      .execute();
    changed = added.length > 0;
  } else {
    const query = db.deleteFrom("relaxations").where("key", "=", target.key);
    const removed = await (
      sourceId === null
        ? query.where("sourceId", "is", null)
        : query.where("sourceId", "=", sourceId)
    )
      .returning("id")
      .execute();
    changed = removed.length > 0;
  }
  if (changed) {
    await recordAuthEvent(db, {
      action: on ? "relaxation_enabled" : "relaxation_disabled",
      actorId: actor.id,
      method: actor.method ?? "admin",
      detail: target.key,
      ip: actor.ip ?? null,
    });
  }
  return changed;
}

/** Every relaxation of the instance, the newest first, as Administration lists them. */
export async function listRelaxations(db: Database) {
  const rows = await db
    .selectFrom("relaxations as r")
    .leftJoin("sources as s", "s.id", "r.sourceId")
    .leftJoin("users as u", "u.id", "r.enabledBy")
    .select([
      "r.key",
      "r.sourceId",
      "s.name as sourceName",
      "r.enabledBy",
      "u.displayName as enabledByName",
      "r.enabledAt",
      "r.consequence",
    ])
    .orderBy("r.enabledAt", "desc")
    .orderBy("r.id")
    .execute();
  return rows.map((row) => ({
    key: relaxationKeySchema.parse(row.key),
    source:
      row.sourceId && row.sourceName !== null
        ? { id: row.sourceId, name: row.sourceName }
        : null,
    enabledBy:
      row.enabledBy && row.enabledByName !== null
        ? { id: row.enabledBy, name: row.enabledByName }
        : null,
    enabledAt: row.enabledAt.toISOString(),
    consequence: row.consequence,
  }));
}
