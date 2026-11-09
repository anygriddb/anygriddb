import type { ParameterizedSql } from "@anygriddb/core";
import { runStatement, type Database, type Tx } from "@anygriddb/db";
import { sql } from "kysely";
import {
  queueSummaryEvent,
  queueTransactionEvents,
  type SummaryEvent,
} from "../queue/jobs.js";
import { rethrowAuditError } from "./pg-error.js";
import { withTransactionRetry } from "./retry.js";

export type AuditTx = Tx;

export type AuditContext = {
  userId: string;
  tableId?: string;
  reason?: string | null;
  action?: string;
  unlock?: boolean;
  /** web, api, import, restore, form:<id>, automation:<id>. */
  source?: string;
  /**
   * Queues the transaction's row events for webhooks, automations, and
   * notifications, in the same transaction. `depth` counts the automations
   * that led to the write.
   */
  events?: { depth: number } | { summary: SummaryEvent };
};

/** Runs SQL built by `@anygriddb/core` inside an audited transaction. */
export async function runRows(
  tx: AuditTx,
  statement: ParameterizedSql,
): Promise<Record<string, unknown>[]> {
  return runStatement(tx, statement);
}

/**
 * One transaction whose writes the audit triggers attribute to `context`:
 * who, on which table, why, and from where. Every write to a user table,
 * and to the audited catalog, runs in one.
 */
export async function withAudit<T>(
  db: Database,
  context: AuditContext,
  fn: (tx: AuditTx) => Promise<T>,
): Promise<T> {
  try {
    return await withTransactionRetry(() =>
      db.transaction().execute(async (tx) => {
        await sql`
          select
            set_config('anygrid.user_id', ${context.userId}, true),
            set_config('anygrid.table_id', ${context.tableId ?? ""}, true),
            set_config('anygrid.reason', ${context.reason ?? ""}, true),
            set_config('anygrid.action', ${context.action ?? ""}, true),
            set_config('anygrid.unlock', ${context.unlock ? "on" : ""}, true),
            set_config('anygrid.source', ${context.source ?? ""}, true)
        `.execute(tx);
        const result = await fn(tx);
        if (context.events && "summary" in context.events) {
          await queueSummaryEvent(tx, context.events.summary);
        } else if (context.events) {
          await queueTransactionEvents(tx, context.events.depth);
        }
        return result;
      }),
    );
  } catch (error) {
    rethrowAuditError(error);
  }
}
