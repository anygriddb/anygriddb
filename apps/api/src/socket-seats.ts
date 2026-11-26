/**
 * The live connections of each account, counted across every process of
 * the instance (ADR 0132, family 3): one tab is one socket, and an account
 * holds at most the sockets "Limits and usage" allows, however many
 * processes serve it. Each process keeps one row an account in
 * `live_sockets`, with how many sockets it holds open for it, and renews
 * its rows while it lives; the rows of a process that stopped renewing
 * them are no longer counted, then removed.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";

/** How often a process renews its rows. */
export const RENEW_MS = 30_000;
/** Rows not renewed for this long are a stopped process's: not counted. */
const COUNTED_FOR = sql.lit("90 seconds");
/** And removed after this long. */
const KEPT_FOR = sql.lit("5 minutes");

/**
 * What taking a seat answered: one more socket counted, the account at
 * its limit, or not counted because the database did not answer (the
 * process's own count then still bounds the account).
 */
export type Seat = "taken" | "full" | "uncounted";

export class SocketSeats {
  readonly processId = randomUUID();

  constructor(private readonly db: Database) {}

  /**
   * One more socket for an account, unless it holds all it may across the
   * instance. One account at a time: two sockets opened at once on two
   * processes would both count before either has written.
   */
  async take(userId: string, allowed: number): Promise<"taken" | "full"> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`sockets:${userId}`}))`.execute(
        tx,
      );
      const { rows } = await sql<{ open: number }>`
        select coalesce(sum("open"), 0)::int as "open"
          from live_sockets
         where user_id = ${userId}
           and seen_at > now() - ${COUNTED_FOR}::interval
      `.execute(tx);
      if ((rows[0]?.open ?? 0) >= allowed) return "full";
      await sql`
        insert into live_sockets as s (process_id, user_id, "open")
        values (${this.processId}, ${userId}, 1)
        on conflict (process_id, user_id)
        do update set "open" = s."open" + 1, seen_at = now()
      `.execute(tx);
      return "taken";
    });
  }

  /** Gives back the seat of one of an account's sockets, once it closed. */
  async leave(userId: string): Promise<void> {
    await sql`
      with gone as (
        delete from live_sockets
         where process_id = ${this.processId}
           and user_id = ${userId}
           and "open" <= 1
      )
      update live_sockets
         set "open" = "open" - 1
       where process_id = ${this.processId}
         and user_id = ${userId}
         and "open" > 1
    `.execute(this.db);
  }

  /** Renews this process's rows, and removes those of processes long stopped. */
  async renew(): Promise<void> {
    await sql`
      update live_sockets set seen_at = now()
       where process_id = ${this.processId}
    `.execute(this.db);
    await sql`
      delete from live_sockets where seen_at < now() - ${KEPT_FOR}::interval
    `.execute(this.db);
  }

  /** Gives back every seat this process holds, when it stops. */
  async close(): Promise<void> {
    await sql`
      delete from live_sockets where process_id = ${this.processId}
    `.execute(this.db);
  }
}

/**
 * A seat for a socket: what the instance counts, or `uncounted` when the
 * database did not answer, said to `warn`.
 */
export async function seatFor(
  seats: SocketSeats,
  userId: string,
  allowed: number,
  warn: (error: unknown) => void,
): Promise<Seat> {
  try {
    return await seats.take(userId, allowed);
  } catch (error) {
    warn(error);
    return "uncounted";
  }
}
