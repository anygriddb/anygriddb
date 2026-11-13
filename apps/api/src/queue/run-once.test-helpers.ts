import { runOnce, type TaskList } from "graphile-worker";
import type pg from "pg";

const SETTLE_TIMEOUT_MS = 5_000;

/**
 * Runs every job waiting, and those they queue, then waits until the worker
 * has marked the last one done: graphile-worker deletes a finished job
 * without holding up the run, so a job can still be there, locked, when
 * `runOnce` returns.
 */
export async function runJobs(
  pool: pg.Pool,
  taskList: TaskList,
): Promise<void> {
  await runOnce({ pgPool: pool, taskList });
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const result = await pool.query<{ locked: string }>(
      `select count(*) as locked
         from graphile_worker._private_jobs
        where locked_at is not null`,
    );
    if (result.rows[0]?.locked === "0") return;
    if (Date.now() > deadline) {
      throw new Error("jobs still locked after the run");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
