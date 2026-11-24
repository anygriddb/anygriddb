/**
 * The indexes the change trail's copy is read by (ADRs 0120, 0121). A short trail
 * got it from its migration. A long one gets it here, beside the writes: a
 * migration runs in a transaction, where an index cannot be built that way,
 * and built otherwise it would hold every write until it ends.
 */
import type { Database } from "@anygriddb/db";
import pg from "pg";
import {
  TRAIL_INDEXES,
  trailOrderIndexed,
} from "../integrations/trail-shipping.js";

const LOCK = "anygriddb.trail_index";
/** Opening the connection this work has to itself. */
const CONNECT_MS = 30_000;
/** The index of a very long trail, waits for running writes included. */
const BUILD_MS = 4 * 60 * 60 * 1000;

type Log = {
  info: (fields: object, message: string) => void;
  error: (fields: object, message: string) => void;
};

/**
 * Builds the index when it is missing or was left unusable by a build that
 * stopped, on a connection of its own. Several instances starting together
 * leave the work to the first.
 */
export async function buildTrailIndex(
  db: Database,
  connectionString: string,
  log: Log,
): Promise<void> {
  if (await trailOrderIndexed(db)) return;
  const client = new pg.Client({
    connectionString,
    application_name: "anygriddb-trail-index",
    connectionTimeoutMillis: CONNECT_MS,
    statement_timeout: BUILD_MS,
  });
  client.on("error", (error: Error) => {
    log.error({ err: error }, "trail index connection failed");
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ got: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as got",
      [LOCK],
    );
    if (!rows[0]?.got) return;
    const valid = await client.query<{ name: string }>(
      `select c.relname as name from pg_index i
         join pg_class c on c.oid = i.indexrelid
        where c.relname = any($1::text[]) and i.indisvalid`,
      [Object.keys(TRAIL_INDEXES)],
    );
    for (const [name, columns] of Object.entries(TRAIL_INDEXES)) {
      if (valid.rows.some((row) => row.name === name)) continue;
      // One left unusable by a build that stopped is built again.
      await client.query(`drop index concurrently if exists "${name}"`);
      await client.query(
        `create index concurrently "${name}" on audit_events ${columns}`,
      );
      log.info({ index: name }, "trail index built");
    }
  } finally {
    await client.end();
  }
}
