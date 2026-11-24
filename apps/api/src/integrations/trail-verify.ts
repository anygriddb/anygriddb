/**
 * What the collectors hold of the change trail, compared with the database
 * (ADR 0120): `anygriddb trail verify <file>`. The file is what a collector
 * kept, one batch a line, as the HTTPS collector got it or as a syslog
 * line. A batch lost or changed, an event changed, deleted outside a
 * purge, given another author, or never sent, is said.
 */
import { POLICY_BOUNDS } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { keyOf, type KeyRing } from "../auth/key-ring.js";
import { ERASED_USER_ID } from "../data/erasure.js";
import {
  batchDigest,
  fingerprint,
  TRAIL_ROW,
  type TrailBatch,
  type TrailEntry,
  type TrailRow,
} from "./trail-shipping.js";

export type FindingKind =
  /** A batch whose digest is not what its fields give. */
  | "batch_altered"
  /** A number between two the file holds, and absent from it. */
  | "batch_missing"
  /** A batch whose previous digest is not the one before it. */
  | "chain_broken"
  /** Two batches of one number, not the same: a restore, or a forgery. */
  | "batch_forked"
  /** A batch signed with a key the instance no longer holds. */
  | "key_unknown"
  | "event_altered"
  /** Gone from the database, and younger than anything a purge takes. */
  | "event_deleted"
  /** Another author than the one sent, and not the placeholder of an erasure. */
  | "author_changed"
  /** In the database between two events sent, and never sent. */
  | "event_not_sent";

export type Finding = { kind: FindingKind; batch?: number; id?: string };

export type VerifyReport = {
  batches: number;
  events: number;
  /** Events the database holds as they were sent. */
  matched: number;
  /** Gone in a purge: older than the trail is kept for. */
  purged: number;
  /** Their author's account was erased since. */
  erased: number;
  findings: Finding[];
  /** Findings past the first thousand, counted and not listed. */
  more: number;
};

const LISTED = 1_000;
/** Events read from the database at once. */
const CHUNK = 1_000;

function isBatch(value: unknown): value is TrailBatch {
  if (!value || typeof value !== "object") return false;
  const batch = value as Partial<TrailBatch>;
  return (
    batch.action === "trail_batch" &&
    Number.isSafeInteger(batch.batch) &&
    typeof batch.key === "string" &&
    typeof batch.digest === "string" &&
    Array.isArray(batch.events)
  );
}

/**
 * The batches of a collector's file: a JSON object a line, or a syslog line
 * whose message is one. Answers how many lines were not a batch.
 */
export function readBatches(text: string): {
  batches: TrailBatch[];
  unreadable: number;
} {
  const batches: TrailBatch[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) {
      if (line.trim() !== "") unreadable += 1;
      continue;
    }
    try {
      const value: unknown = JSON.parse(line.slice(start));
      if (isBatch(value)) batches.push(value);
      else unreadable += 1;
    } catch {
      unreadable += 1;
    }
  }
  return { batches, unreadable };
}

/**
 * The batches in their order, one of each number, and what their chain
 * says: a digest that is not its fields', a number missing, a previous
 * digest that is not the batch before's.
 */
export function checkChain(batches: readonly TrailBatch[]): {
  ordered: TrailBatch[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const byNumber = new Map<number, TrailBatch>();
  for (const batch of batches) {
    const held = byNumber.get(batch.batch);
    if (!held) byNumber.set(batch.batch, batch);
    else if (held.digest !== batch.digest) {
      findings.push({ kind: "batch_forked", batch: batch.batch });
    }
  }
  const ordered = [...byNumber.values()].sort((a, b) => a.batch - b.batch);
  let before: TrailBatch | undefined;
  for (const batch of ordered) {
    if (batchDigest(batch) !== batch.digest) {
      findings.push({ kind: "batch_altered", batch: batch.batch });
    }
    if (before) {
      for (let lost = before.batch + 1; lost < batch.batch; lost += 1) {
        findings.push({ kind: "batch_missing", batch: lost });
      }
      if (
        before.batch + 1 === batch.batch &&
        batch.previous !== before.digest
      ) {
        findings.push({ kind: "chain_broken", batch: batch.batch });
      }
    }
    before = batch;
  }
  return { ordered, findings };
}

export type EventVerdict =
  | "matched"
  | "purged"
  | "erased"
  | "key_unknown"
  | "event_altered"
  | "event_deleted"
  | "author_changed";

export type EventContext = {
  /** The key of this use under the master the batch names, if held. */
  key: (id: string) => Buffer | undefined;
  /** Events before this instant may have gone in a purge; null: none did. */
  purgedBefore: string | null;
  /** Whether an account still exists. */
  exists: (userId: string) => boolean;
};

/** One author as sent against the database's. */
function author(
  sent: string | null,
  held: string | null,
  context: EventContext,
): "same" | "erased" | "changed" {
  if (sent === held) return "same";
  // An erasure gives the author's events to one placeholder, and deletes
  // the account: a placeholder where the account still exists is not one.
  if (held === ERASED_USER_ID && sent !== null && !context.exists(sent)) {
    return "erased";
  }
  return "changed";
}

/** What an event sent says against what the database holds of it. */
export function verdictOf(
  entry: TrailEntry,
  keyId: string,
  row: TrailRow | undefined,
  context: EventContext,
): EventVerdict {
  if (!row) {
    return context.purgedBefore !== null && entry.at < context.purgedBefore
      ? "purged"
      : "event_deleted";
  }
  const key = context.key(keyId);
  if (!key) return "key_unknown";
  const same =
    fingerprint(key, row.content) === entry.fingerprint &&
    row.order === entry.order &&
    row.at === entry.at &&
    row.action === entry.action;
  if (!same) return "event_altered";
  const authors = [
    author(entry.userId, row.userId, context),
    author(entry.actedAs, row.actedAs, context),
  ];
  if (authors.includes("changed")) return "author_changed";
  return authors.includes("erased") ? "erased" : "matched";
}

/** The trail's events of these ids, by id. */
async function rowsOf(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, TrailRow>> {
  const { rows } = await sql<TrailRow>`select ${TRAIL_ROW} from audit_events
    where id = any(${ids}::uuid[])`.execute(db);
  return new Map(rows.map((row) => [row.id, row]));
}

async function accountsOf(
  db: Database,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = await db
    .selectFrom("users")
    .select("id")
    .where("id", "in", ids)
    .execute();
  return new Set(found.map((user) => user.id));
}

/**
 * Before when events may have gone in a purge: the latest purge's own
 * bound, never later than the shortest retention an instance can choose,
 * which is all the owner's purge takes whatever it is told. Null when no
 * purge ever ran.
 */
async function purgeReach(db: Database, now: Date): Promise<string | null> {
  const { rows } = await sql<{ before: Date | null }>`select max(
      (new_value ->> 'before')::timestamptz) as "before"
    from audit_events where action = 'purge' and source = 'retention'`.execute(
    db,
  );
  const before = rows[0]?.before;
  if (!before) return null;
  const floor =
    now.getTime() - POLICY_BOUNDS.auditRetentionDays.min * 86_400_000;
  return new Date(Math.min(before.getTime(), floor)).toISOString();
}

/** A uuid as the database writes it: a batch from elsewhere may say it otherwise. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Compares what a collector holds with the database. */
export async function verifyTrail(
  db: Database,
  ring: KeyRing,
  text: string,
  now: Date = new Date(),
): Promise<VerifyReport & { unreadable: number }> {
  const { batches, unreadable } = readBatches(text);
  const { ordered, findings } = checkChain(batches);
  const purgedBefore = await purgeReach(db, now);
  const report: VerifyReport = {
    batches: ordered.length,
    events: 0,
    matched: 0,
    purged: 0,
    erased: 0,
    findings,
    more: 0,
  };
  const entries = ordered.flatMap((batch) =>
    batch.events.map((entry) => ({ entry, batch })),
  );
  report.events = entries.length;
  const sent = new Set<string>();
  for (let at = 0; at < entries.length; at += CHUNK) {
    const chunk = entries.slice(at, at + CHUNK);
    const ids = chunk
      .map(({ entry }) => entry.id)
      .filter((id) => UUID.test(id));
    const rows = await rowsOf(db, ids);
    const authors = chunk.flatMap(({ entry }) =>
      [entry.userId, entry.actedAs].filter(
        (id): id is string => id !== null && UUID.test(id),
      ),
    );
    const accounts = await accountsOf(db, [...new Set(authors)]);
    for (const { entry, batch } of chunk) {
      sent.add(entry.id);
      const verdict = verdictOf(entry, batch.key, rows.get(entry.id), {
        key: (id) => keyOf(ring, id, "trail"),
        purgedBefore,
        exists: (userId) => accounts.has(userId),
      });
      if (verdict === "matched") report.matched += 1;
      else if (verdict === "purged") report.purged += 1;
      else if (verdict === "erased") report.erased += 1;
      else findings.push({ kind: verdict, batch: batch.batch, id: entry.id });
    }
  }
  await notSent(db, ordered, sent, findings);
  report.more = Math.max(0, findings.length - LISTED);
  report.findings = findings.slice(0, LISTED);
  return { ...report, unreadable };
}

/**
 * The events the database holds between the first and the last sent, read
 * in their order, that no batch carried: skipped, or added since.
 */
async function notSent(
  db: Database,
  ordered: readonly TrailBatch[],
  sent: ReadonlySet<string>,
  findings: Finding[],
): Promise<void> {
  const orders = ordered.flatMap((batch) =>
    batch.events.map((entry) => entry.order),
  );
  const numbers = orders
    .filter((order) => /^\d{1,19}$/.test(order))
    .map(BigInt);
  if (numbers.length === 0) return;
  const first = numbers.reduce((a, b) => (b < a ? b : a));
  const last = numbers.reduce((a, b) => (b > a ? b : a));
  let after = first - 1n;
  for (;;) {
    const { rows } = await sql<{
      id: string;
      order: string;
    }>`select id::text as "id",
        write_order::text as "order" from audit_events
      where write_order > ${after.toString()}::bigint
        and write_order <= ${last.toString()}::bigint
      order by write_order limit ${CHUNK}`.execute(db);
    for (const row of rows) {
      if (!sent.has(row.id))
        findings.push({ kind: "event_not_sent", id: row.id });
    }
    const end = rows.at(-1);
    if (!end || rows.length < CHUNK) return;
    after = BigInt(end.order);
  }
}

const SAID: Record<FindingKind, string> = {
  batch_altered: "batch changed since it was sent",
  batch_missing: "batch missing from the file",
  chain_broken: "batch that does not follow the one before",
  batch_forked: "two batches of one number (a restore, or a forgery)",
  key_unknown: "batch made with a key this instance no longer holds",
  event_altered: "event changed since it was sent",
  event_deleted: "event deleted, and younger than a purge takes",
  author_changed: "event given another author",
  event_not_sent: "event never sent",
};

/** The report as the command prints it. */
export function describeTrailReport(
  report: VerifyReport & { unreadable: number },
): string {
  const lines = [
    `${String(report.batches)} batches, ${String(report.events)} events: ${String(report.matched)} as sent, ${String(report.purged)} purged, ${String(report.erased)} of an erased account`,
  ];
  if (report.unreadable > 0) {
    lines.push(
      `${String(report.unreadable)} lines of the file were not batches`,
    );
  }
  for (const finding of report.findings) {
    const where = [
      finding.batch === undefined ? "" : `batch ${String(finding.batch)}`,
      finding.id ?? "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`${SAID[finding.kind]}${where ? `: ${where}` : ""}`);
  }
  if (report.more > 0) lines.push(`and ${String(report.more)} more`);
  if (report.findings.length === 0) lines.push("nothing was rewritten");
  return lines.join("\n");
}
