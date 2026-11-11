/**
 * Persisted result of the opt-in GitHub release check (ADR 0048): what
 * Administration shows, and whether the update banner is still open.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { BUILD } from "./build-info.js";
import {
  checkLatestRelease,
  isNewer,
  type FetchLike,
  type ReleaseCheckResult,
} from "./release-check.js";
import { readSettings } from "./settings.js";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const statusSchema = z.object({
  current: z.string().regex(SEMVER),
  latest: z.string().regex(SEMVER),
  newer: z.boolean(),
  url: z.url(),
  checkedAt: z.date(),
  dismissedVersion: z.string().regex(SEMVER).nullable(),
});

export type ReleaseStatus = z.infer<typeof statusSchema>;

/** What Administration needs: the stored check, and whether to show a banner. */
export type ReleaseNotice = {
  status: ReleaseStatus | null;
  /** True when releaseCheck is on, a newer release exists, and it was not dismissed. */
  notify: boolean;
};

function rowToStatus(row: {
  current: string;
  latest: string;
  newer: boolean;
  url: string;
  checkedAt: Date;
  dismissedVersion: string | null;
}): ReleaseStatus {
  return statusSchema.parse({
    current: row.current,
    latest: row.latest,
    newer: row.newer,
    url: row.url,
    checkedAt: row.checkedAt,
    dismissedVersion: row.dismissedVersion,
  });
}

/**
 * The last check, measured against the version running now: after an
 * upgrade, the release it found is no longer newer, before the next check.
 */
export function asRunning(
  status: ReleaseStatus,
  running: string,
): ReleaseStatus {
  return {
    ...status,
    current: running,
    newer: isNewer(running, status.latest),
  };
}

export async function readReleaseStatus(
  db: Database,
  running = BUILD.version,
): Promise<ReleaseStatus | null> {
  const row = await db
    .selectFrom("releaseStatus")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst();
  return row ? asRunning(rowToStatus(row), running) : null;
}

/**
 * Keeps a previous dismissal only when it still names this exact latest;
 * a yet-newer release opens the banner again.
 */
export function retainedDismissal(
  result: Pick<ReleaseCheckResult, "latest" | "newer">,
  previous: Pick<ReleaseStatus, "dismissedVersion"> | null,
): string | null {
  return result.newer && previous?.dismissedVersion === result.latest
    ? previous.dismissedVersion
    : null;
}

/**
 * Writes a successful check. Keeps a previous dismissal only when it still
 * names this exact latest; a yet-newer release opens the banner again.
 */
export async function writeReleaseStatus(
  db: Database,
  result: ReleaseCheckResult,
  previous: ReleaseStatus | null,
): Promise<ReleaseStatus> {
  const dismissedVersion = retainedDismissal(result, previous);
  const checkedAt = new Date();
  const status = statusSchema.parse({
    current: result.current,
    latest: result.latest,
    newer: result.newer,
    url: result.url,
    checkedAt,
    dismissedVersion,
  });
  await db
    .insertInto("releaseStatus")
    .values({
      id: true,
      current: status.current,
      latest: status.latest,
      newer: status.newer,
      url: status.url,
      checkedAt: status.checkedAt,
      dismissedVersion: status.dismissedVersion,
    })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        current: status.current,
        latest: status.latest,
        newer: status.newer,
        url: status.url,
        checkedAt: status.checkedAt,
        dismissedVersion: status.dismissedVersion,
        updatedAt: new Date(),
      }),
    )
    .execute();
  return status;
}

/** Marks the currently known latest as dismissed so the banner hides. */
export async function dismissReleaseNotice(
  db: Database,
): Promise<ReleaseStatus> {
  const previous = await readReleaseStatus(db);
  if (!previous || !previous.newer) {
    throw new AppError("not_found");
  }
  const status = statusSchema.parse({
    ...previous,
    dismissedVersion: previous.latest,
  });
  await db
    .updateTable("releaseStatus")
    .set({
      dismissedVersion: status.dismissedVersion,
      updatedAt: new Date(),
    })
    .where("id", "=", true)
    .execute();
  return status;
}

export function releaseNotify(
  releaseCheck: boolean,
  status: ReleaseStatus | null,
): boolean {
  if (!releaseCheck || !status || !status.newer) return false;
  return status.dismissedVersion !== status.latest;
}

export async function releaseNotice(db: Database): Promise<ReleaseNotice> {
  const [settings, status] = await Promise.all([
    readSettings(db),
    readReleaseStatus(db),
  ]);
  return {
    status,
    notify: releaseNotify(settings.releaseCheck, status),
  };
}

/**
 * Runs the GitHub check when the administrator opted in, and stores the
 * result. Callers that already verified `releaseCheck` may pass it.
 */
export async function runReleaseCheck(
  db: Database,
  options: {
    fetch?: FetchLike;
    signal?: AbortSignal;
    releaseCheck?: boolean;
  } = {},
): Promise<ReleaseStatus> {
  const releaseCheck =
    options.releaseCheck ?? (await readSettings(db)).releaseCheck;
  if (!releaseCheck) {
    throw new AppError("release_check_disabled");
  }
  const result = await checkLatestRelease(BUILD.version, {
    fetch: options.fetch,
    signal: options.signal,
  });
  const previous = await readReleaseStatus(db);
  return writeReleaseStatus(db, result, previous);
}

/**
 * Daily cron: no-op while releaseCheck is off; on failure keeps the last
 * stored status and logs through the worker.
 */
export async function runScheduledReleaseCheck(
  db: Database,
  options: {
    fetch?: FetchLike;
    log: (error: unknown, message: string) => void;
  },
): Promise<void> {
  const settings = await readSettings(db);
  if (!settings.releaseCheck) return;
  try {
    await runReleaseCheck(db, {
      fetch: options.fetch,
      releaseCheck: true,
    });
  } catch (error) {
    options.log(error, "release check failed");
  }
}
