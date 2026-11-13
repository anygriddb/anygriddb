/**
 * A failed job put back on the queue by its author, against a real
 * database and the queue's own tables.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  claimJob,
  enqueueJob,
  recoverJobs,
  retryJob,
  runJob,
  type QueueDeps,
} from "./jobs.js";
import { recordingBus } from "./realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");
const TABLE = "00000000-0000-4000-8000-000000000001";

describe("a job retried by its author", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let deps: QueueDeps;
  let author = "";
  let other = "";

  beforeAll(async () => {
    const created = await createTestDatabase("job_retry");
    db = created.db;
    close = created.close;
    deps = { db, bus: recordingBus().bus, log: vi.fn() };
    const people = await db
      .insertInto("users")
      .values([
        { email: `retry-${suffix}@example.com`, displayName: "Author" },
        { email: `retry-other-${suffix}@example.com`, displayName: "Other" },
      ])
      .returning("id")
      .execute();
    author = people[0]?.id ?? "";
    other = people[1]?.id ?? "";
  });

  afterAll(async () => {
    await close?.();
  });

  function startExport(userId = author) {
    return enqueueJob(deps, {
      kind: "export",
      userId,
      input: { tableId: TABLE, format: "csv" },
    });
  }

  /** Claims the job and runs it with a runner that fails. */
  async function fail(jobId: string) {
    const claimed = await claimJob(db, jobId);
    if (!claimed) throw new Error("not claimed");
    return runJob(
      deps,
      claimed,
      () => Promise.reject(new Error("the store is away")),
      new AbortController().signal,
    );
  }

  /** The queue's entries for a job, whatever state they are in. */
  async function queued(jobId: string): Promise<number> {
    const found = await sql<{ count: string }>`
      select count(*) as count from graphile_worker._private_jobs
       where payload->>'jobId' = ${jobId}
    `.execute(db);
    return Number(found.rows[0]?.count ?? 0);
  }

  it("queues a failed export again, as it was asked, and it can run", async () => {
    const job = await startExport();
    const failed = await fail(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("internal_error");

    const again = await retryJob(deps, author, job.id);
    expect(again).toMatchObject({
      id: job.id,
      status: "queued",
      input: job.input,
      error: null,
      errorCode: null,
      progressDone: 0,
      startedAt: null,
      finishedAt: null,
    });
    const claimed = await claimJob(db, job.id);
    expect(claimed?.attempts).toBe(2);
    if (!claimed) throw new Error("not claimed");
    const done = await runJob(
      deps,
      claimed,
      () => Promise.resolve({ result: { rows: 0 } }),
      new AbortController().signal,
    );
    expect(done?.status).toBe("done");
  });

  it("queues a new entry when the first run's worker died with its own", async () => {
    const job = await startExport();
    // The worker stopped without a word: the lease lapses, and the
    // queue's entry for that run stays where it was.
    await claimJob(db, job.id);
    await db
      .updateTable("jobs")
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where("id", "=", job.id)
      .execute();
    expect(await recoverJobs(deps)).toBe(1);
    expect(await queued(job.id)).toBe(1);

    const again = await retryJob(deps, author, job.id);
    expect(again.status).toBe("queued");
    expect(await queued(job.id)).toBe(2);
  });

  it("refuses a job that did not fail, an import, and someone else's job", async () => {
    const waiting = await startExport();
    await expect(retryJob(deps, author, waiting.id)).rejects.toMatchObject({
      code: "job_not_retryable",
    });

    const theirs = await startExport(other);
    await fail(theirs.id);
    await expect(retryJob(deps, author, theirs.id)).rejects.toMatchObject({
      code: "unknown_job",
    });

    const failedImport = await db
      .insertInto("jobs")
      .values({
        kind: "import",
        userId: author,
        status: "failed",
        input: {},
        attempts: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await expect(retryJob(deps, author, failedImport.id)).rejects.toMatchObject(
      { code: "job_not_retryable" },
    );

    const cancelled = await db
      .insertInto("jobs")
      .values({
        kind: "export",
        userId: author,
        status: "cancelled",
        input: {},
        attempts: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await expect(retryJob(deps, author, cancelled.id)).rejects.toMatchObject({
      code: "job_not_retryable",
    });
  });
});
