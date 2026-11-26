/**
 * A role of Administration given in a test, as an administrator gives it
 * (ADR 0131): an attribution at the instance, on the change trail.
 */
import type { InstanceCaller } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { withAudit } from "../data/audit-context.js";
import { setInstanceAttribution } from "./instance-roles.js";

export async function giveInstanceRole(
  db: Database,
  userId: string,
  role: InstanceCaller = "administrator",
  held = true,
): Promise<void> {
  await withAudit(db, { userId, source: "test" }, (tx) =>
    setInstanceAttribution(tx, { userId, role, held }),
  );
}
