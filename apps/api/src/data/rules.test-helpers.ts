/**
 * A field or row rule set as a manager sets it since roles add up (ADR
 * 0131): a rule narrows only a role given on its table, so someone with a
 * role of their own on the base is given it table by table first.
 */
import type { Database } from "@anygriddb/db";
import { setTableAcl } from "./acl.js";
import { splitBaseRole } from "./members.js";

/** Their own role on the table's base, given table by table, if they hold one. */
export async function giveTableByTable(
  db: Database,
  actorId: string,
  input: { tableId: string; userId: string },
): Promise<void> {
  const table = await db
    .selectFrom("dataTables")
    .select("baseId")
    .where("id", "=", input.tableId)
    .executeTakeFirstOrThrow();
  const own = await db
    .selectFrom("attributions")
    .select("id")
    .where("userId", "=", input.userId)
    .where("scope", "=", "base")
    .where("scopeId", "=", table.baseId)
    .executeTakeFirst();
  if (own) {
    await splitBaseRole(db, actorId, {
      baseId: table.baseId,
      userId: input.userId,
    });
  }
}

/** A rule on someone's role on a table, given there alone first. */
export async function narrowOn(
  db: Database,
  actorId: string,
  input: Parameters<typeof setTableAcl>[2],
): Promise<void> {
  await giveTableByTable(db, actorId, input);
  await setTableAcl(db, actorId, input);
}
