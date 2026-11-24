/**
 * What the collectors hold of the change trail, compared with the database
 * (ADR 0120): `anygriddb trail verify < <file>`. The file is what a collector
 * kept, one batch a line, as the HTTPS collector got it or as a syslog
 * line. A batch lost or changed, an event changed, deleted outside a
 * purge, given another author, or never sent, is said.
 *
 * The file is read a line at a time, and what is kept of it is bounded: a
 * few bytes a batch for its chain, 24 an event to find what was never
 * sent. A month of a busy instance's trail is millions of events.
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

type FindingKind =
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
/** The longest line read: a batch of 25 events stays under 8 KiB. */
export const LINE_BYTES = 1024 * 1024;

/** Findings as they come: the first thousand listed, the others counted. */
export class Findings {
  readonly listed: Finding[] = [];
  more = 0;

  add(finding: Finding): void {
    if (this.listed.length < LISTED) this.listed.push(finding);
    else this.more += 1;
  }

  /**
   * The batches from `from` up to `to`, `to` excluded, all missing. However
   * far apart a forged number puts them, this lists a thousand at most.
   */
  addMissing(from: number, to: number): void {
    const count = to - from;
    const listed = Math.min(count, LISTED - this.listed.length);
    for (let index = 0; index < listed; index += 1) {
      this.listed.push({ kind: "batch_missing", batch: from + index });
    }
    this.more += count - listed;
  }
}

/** A collector's input, a line at a time: null for a line too long to be a batch. */
export async function* linesOf(
  input: AsyncIterable<Buffer | string>,
): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let held = 0;
  let overlong = false;
  for await (const chunk of input) {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a)) {
      const last = data.subarray(0, end);
      if (overlong || held + last.length > LINE_BYTES) yield null;
      else yield Buffer.concat([...parts, last]).toString("utf8");
      parts = [];
      held = 0;
      overlong = false;
      data = data.subarray(end + 1);
    }
    if (overlong) continue;
    if (held + data.length > LINE_BYTES) {
      // What is kept of a line stops here: the rest is read past.
      overlong = true;
      parts = [];
      held = 0;
    } else if (data.length > 0) {
      parts.push(data);
      held += data.length;
    }
  }
  if (overlong) yield null;
  else if (held > 0) yield Buffer.concat(parts).toString("utf8");
}

const textOrNull = (value: unknown) =>
  value === null || typeof value === "string";

function isEntry(value: unknown): value is TrailEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<TrailEntry>;
  return (
    typeof entry.id === "string" &&
    textOrNull(entry.order) &&
    typeof entry.at === "string" &&
    typeof entry.action === "string" &&
    typeof entry.userId === "string" &&
    textOrNull(entry.actedAs) &&
    typeof entry.fingerprint === "string"
  );
}

function isBatch(value: unknown): value is TrailBatch {
  if (!value || typeof value !== "object") return false;
  const batch = value as Partial<TrailBatch>;
  return (
    batch.action === "trail_batch" &&
    Number.isSafeInteger(batch.batch) &&
    textOrNull(batch.previous) &&
    typeof batch.key === "string" &&
    typeof batch.digest === "string" &&
    Array.isArray(batch.events) &&
    batch.events.every(isEntry)
  );
}

/**
 * The batch a line of a collector's file holds: a JSON object, or a syslog
 * line whose message is one. Null when it holds none.
 */
export function batchOf(line: string): TrailBatch | null {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try {
    const value: unknown = JSON.parse(line.slice(start));
    return isBatch(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The chain of the batches read, a digest and the previous one's a batch:
 * a digest that is not its fields', two batches of one number, a number
 * missing, a previous digest that is not the batch before's.
 */
export class BatchChain {
  private readonly links = new Map<
    number,
    { digest: string; previous: string | null }
  >();

  get size(): number {
    return this.links.size;
  }

  /**
   * Takes a batch as read. Answers whether its events are to be checked:
   * not when a batch of its number was read before, the same or not.
   */
  take(batch: TrailBatch, findings: Findings): boolean {
    const held = this.links.get(batch.batch);
    if (held) {
      if (held.digest !== batch.digest) {
        findings.add({ kind: "batch_forked", batch: batch.batch });
      }
      return false;
    }
    this.links.set(batch.batch, {
      digest: batch.digest,
      previous: batch.previous,
    });
    if (batchDigest(batch) !== batch.digest) {
      findings.add({ kind: "batch_altered", batch: batch.batch });
    }
    return true;
  }

  /** Once every batch is read: the numbers missing, and the links broken. */
  finish(findings: Findings): void {
    const numbers = Float64Array.from(this.links.keys()).sort((a, b) => a - b);
    let before: { batch: number; digest: string } | undefined;
    for (const batch of numbers) {
      const link = this.links.get(batch);
      if (!link) continue;
      if (before && batch > before.batch + 1) {
        findings.addMissing(before.batch + 1, batch);
      } else if (before && link.previous !== before.digest) {
        findings.add({ kind: "chain_broken", batch });
      }
      before = { batch, digest: link.digest };
    }
  }
}

/** A uuid as the database writes it: a batch from elsewhere may say it otherwise. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_BYTES = 16;

/** A uuid's 16 bytes. */
function idBytes(id: string): Buffer {
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

/** A uuid as text, from its 16 bytes. */
function idText(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The events a file carried, by a number that orders them (a write order,
 * or a time in microseconds) then their id: 24 bytes an event. Sorted once
 * read, then asked.
 */
export class SentEvents {
  private keys = new Float64Array(1024);
  private ids = Buffer.alloc(1024 * ID_BYTES);
  private count = 0;
  private sorted = true;

  get size(): number {
    return this.count;
  }

  add(key: number, id: string): void {
    if (this.count === this.keys.length) {
      const keys = new Float64Array(this.count * 2);
      keys.set(this.keys);
      this.keys = keys;
      const ids = Buffer.alloc(this.count * 2 * ID_BYTES);
      this.ids.copy(ids);
      this.ids = ids;
    }
    this.keys[this.count] = key;
    idBytes(id).copy(this.ids, this.count * ID_BYTES);
    if (this.count > 0 && this.compare(this.count - 1, this.count) > 0) {
      this.sorted = false;
    }
    this.count += 1;
  }

  /** The event at `a` against the one at `b`. */
  private compare(a: number, b: number): number {
    const keyA = this.keys[a] ?? 0;
    const keyB = this.keys[b] ?? 0;
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    return this.ids.compare(
      this.ids,
      b * ID_BYTES,
      (b + 1) * ID_BYTES,
      a * ID_BYTES,
      (a + 1) * ID_BYTES,
    );
  }

  /** In their order. A file read as written is already: nothing moves. */
  sort(): void {
    if (this.sorted) return;
    const order = Uint32Array.from({ length: this.count }, (_, at) => at).sort(
      (a, b) => this.compare(a, b),
    );
    const keys = new Float64Array(this.count);
    const ids = Buffer.alloc(this.count * ID_BYTES);
    order.forEach((from, to) => {
      keys[to] = this.keys[from] ?? 0;
      this.ids.copy(ids, to * ID_BYTES, from * ID_BYTES, (from + 1) * ID_BYTES);
    });
    this.keys = keys;
    this.ids = ids;
    this.sorted = true;
  }

  /** The first and the last, once sorted. */
  ends(): {
    first: { key: number; id: string };
    last: { key: number; id: string };
  } | null {
    if (this.count === 0) return null;
    const at = (index: number) => ({
      key: this.keys[index] ?? 0,
      id: idText(this.ids.subarray(index * ID_BYTES, (index + 1) * ID_BYTES)),
    });
    return { first: at(0), last: at(this.count - 1) };
  }

  /** Whether this event was carried, once sorted. */
  has(key: number, id: string): boolean {
    const bytes = idBytes(id);
    let low = 0;
    let high = this.count - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const held = this.keys[middle] ?? 0;
      const order =
        held === key
          ? this.ids.compare(
              bytes,
              0,
              ID_BYTES,
              middle * ID_BYTES,
              (middle + 1) * ID_BYTES,
            )
          : held < key
            ? -1
            : 1;
      if (order === 0) return true;
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    return false;
  }
}

/** The time and id of an event, as the copy orders the early ones. */
const EARLY_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** An event's time, as the copy writes it, in microseconds. */
export function microsOf(at: string): number {
  return Date.parse(`${at.slice(0, 19)}Z`) * 1000 + Number(at.slice(20, 26));
}

/** The copy's text of a time in microseconds. */
export function atOf(micros: number): string {
  const seconds = Math.floor(micros / 1_000_000);
  const fraction = String(micros - seconds * 1_000_000).padStart(6, "0");
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
}

/** An event's write order as a number, or null when it is none it could hold. */
function orderOf(order: string | null): number | null {
  if (order === null || !/^\d{1,16}$/.test(order)) return null;
  const number = Number(order);
  return Number.isSafeInteger(number) ? number : null;
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

type Pending = { entry: TrailEntry; batch: TrailBatch };

/** Checks events sent against the database, a chunk at a time. */
async function checkEvents(
  db: Database,
  ring: KeyRing,
  purgedBefore: string | null,
  pending: readonly Pending[],
  report: VerifyReport,
  findings: Findings,
): Promise<void> {
  const ids = pending
    .map(({ entry }) => entry.id)
    .filter((id) => UUID.test(id));
  const rows = await rowsOf(db, ids);
  const authors = pending.flatMap(({ entry }) =>
    [entry.userId, entry.actedAs].filter(
      (id): id is string => id !== null && UUID.test(id),
    ),
  );
  const accounts = await accountsOf(db, [...new Set(authors)]);
  for (const { entry, batch } of pending) {
    const verdict = verdictOf(entry, batch.key, rows.get(entry.id), {
      key: (id) => keyOf(ring, id, "trail"),
      purgedBefore,
      exists: (userId) => accounts.has(userId),
    });
    if (verdict === "matched") report.matched += 1;
    else if (verdict === "purged") report.purged += 1;
    else if (verdict === "erased") report.erased += 1;
    else findings.add({ kind: verdict, batch: batch.batch, id: entry.id });
  }
}

/** Notes an event carried, by its write order, or by its time when it has none. */
function noteSent(
  entry: TrailEntry,
  ordered: SentEvents,
  early: SentEvents,
): void {
  if (!UUID.test(entry.id)) return;
  if (entry.order === null) {
    if (EARLY_AT.test(entry.at)) early.add(microsOf(entry.at), entry.id);
    return;
  }
  const order = orderOf(entry.order);
  if (order !== null) ordered.add(order, entry.id);
}

/** Compares what a collector holds, a line at a time, with the database. */
export async function verifyTrail(
  db: Database,
  ring: KeyRing,
  input: string | Iterable<string | null> | AsyncIterable<string | null>,
  now: Date = new Date(),
): Promise<VerifyReport & { unreadable: number }> {
  const lines = typeof input === "string" ? input.split("\n") : input;
  const purgedBefore = await purgeReach(db, now);
  const report: VerifyReport = {
    batches: 0,
    events: 0,
    matched: 0,
    purged: 0,
    erased: 0,
    findings: [],
    more: 0,
  };
  // What the chain says is listed before what the events say.
  const ofChain = new Findings();
  const ofEvents = new Findings();
  const chain = new BatchChain();
  const ordered = new SentEvents();
  const early = new SentEvents();
  let unreadable = 0;
  let pending: Pending[] = [];
  for await (const line of lines) {
    if (line !== null && line.trim() === "") continue;
    const batch = line === null ? null : batchOf(line);
    if (!batch) {
      unreadable += 1;
      continue;
    }
    if (!chain.take(batch, ofChain)) continue;
    for (const entry of batch.events) {
      report.events += 1;
      noteSent(entry, ordered, early);
      pending.push({ entry, batch });
    }
    if (pending.length >= CHUNK) {
      await checkEvents(db, ring, purgedBefore, pending, report, ofEvents);
      pending = [];
    }
  }
  await checkEvents(db, ring, purgedBefore, pending, report, ofEvents);
  chain.finish(ofChain);
  report.batches = chain.size;
  ordered.sort();
  early.sort();
  await notSent(db, ordered, ofEvents);
  await earlyNotSent(db, early, ofEvents);
  report.findings = [...ofChain.listed, ...ofEvents.listed].slice(0, LISTED);
  report.more =
    ofChain.listed.length +
    ofChain.more +
    ofEvents.listed.length +
    ofEvents.more -
    report.findings.length;
  return { ...report, unreadable };
}

/**
 * The events the database holds between the first and the last sent, read
 * in their order, that no batch carried: skipped, or added since.
 */
async function notSent(
  db: Database,
  sent: SentEvents,
  findings: Findings,
): Promise<void> {
  const ends = sent.ends();
  if (!ends) return;
  let after = String(ends.first.key - 1);
  const last = String(ends.last.key);
  for (;;) {
    const { rows } = await sql<{
      id: string;
      order: string;
    }>`select id::text as "id",
        write_order::text as "order" from audit_events
      where write_order > ${after}::bigint
        and write_order <= ${last}::bigint
      order by write_order limit ${CHUNK}`.execute(db);
    for (const row of rows) {
      if (!sent.has(Number(row.order), row.id)) {
        findings.add({ kind: "event_not_sent", id: row.id });
      }
    }
    const end = rows.at(-1);
    if (!end || rows.length < CHUNK) return;
    after = end.order;
  }
}

/**
 * The events from before the write order the database holds between the
 * first and the last of them sent, by date then id, that no batch carried.
 */
async function earlyNotSent(
  db: Database,
  sent: SentEvents,
  findings: Findings,
): Promise<void> {
  const ends = sent.ends();
  if (!ends) return;
  let after = [atOf(ends.first.key), ends.first.id];
  let inclusive = true;
  const last = [atOf(ends.last.key), ends.last.id];
  for (;;) {
    const { rows } = await sql<{
      id: string;
      at: string;
    }>`select id::text as "id",
        to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "at"
      from audit_events
      where write_order is null
        and ((occurred_at, id) > (${after[0]}::timestamptz, ${after[1]}::uuid)
          or (${inclusive}::boolean
            and (occurred_at, id) = (${after[0]}::timestamptz, ${after[1]}::uuid)))
        and (occurred_at, id) <= (${last[0]}::timestamptz, ${last[1]}::uuid)
      order by occurred_at, id limit ${CHUNK}`.execute(db);
    for (const row of rows) {
      if (!sent.has(microsOf(row.at), row.id)) {
        findings.add({ kind: "event_not_sent", id: row.id });
      }
    }
    const end = rows.at(-1);
    if (!end || rows.length < CHUNK) return;
    after = [end.at, end.id];
    inclusive = false;
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
