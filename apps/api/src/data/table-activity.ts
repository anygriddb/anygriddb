/**
 * When a table was last used, by what the trails hold: its newest event
 * on the change trail (a row, a field, a view, an export, an opening where
 * a manager has them recorded), and, for a table kept in a client's
 * database, its newest write and the newest status a person gave one of
 * its rows, which have trails of their own (ADRs 0028, 0033). What a
 * check found on a locked row has no author and is nobody's use.
 *
 * Reading a table leaves no trace unless its manager asks for one, so
 * this is the last time the trails saw someone, not the last time someone
 * looked. Each trail answers by one probe of its index by table and time.
 */
import { sql, type RawBuilder } from "kysely";

/** The instant, for the table that `alias` names in the query. */
export function lastActivity(alias: string): RawBuilder<Date | null> {
  const id = sql.ref(`${alias}.id`);
  return sql<Date | null>`greatest(
    (select a.occurred_at from audit_events a
      where a.table_id = ${id}
      order by a.occurred_at desc limit 1),
    (select w.requested_at from external_writes w
      where w.table_id = ${id}
      order by w.requested_at desc limit 1),
    (select s.at from external_status_events s
      where s.table_id = ${id} and s.user_id is not null
      order by s.at desc limit 1)
  )`;
}
