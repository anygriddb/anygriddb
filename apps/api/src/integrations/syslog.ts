/**
 * Sign-in trail events sent to a syslog collector (ADR 0084): the events
 * the HTTPS collector gets (ADR 0056), from the queue, tried again when
 * the collector is away, over TLS with its certificate verified (RFC
 * 5425). Never in clear text, never from the request that made the event.
 *
 * The collector is the one the instance's environment names (`SYSLOG_HOST`),
 * else the one saved in Administration (ADR 0105). One an administrator
 * saved is held to what a notification channel is: an address checked
 * before and at the connection, a private one only where an administrator
 * allowed private networks.
 */
import { isIP, type LookupFunction } from "node:net";
import { hostname } from "node:os";
import { AppError, ceilingOf } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { recordAuthEvent } from "../auth/auth-events.js";
import type { SyslogCollector } from "../env.js";
import {
  assertOutboundTarget,
  outboundLookup,
  type OutboundResolve,
} from "../outbound/index.js";
import { sendTlsFrame } from "../outbound/tls-frame.js";
import { addJob, TASKS } from "../queue/jobs.js";
import {
  type CollectorEvent,
  type CollectorPayload,
  collectorPayload,
} from "./siem.js";
import { relaxationAllows } from "../relaxations.js";

/** Connecting, the handshake and the write, together. */
const SEND_TIMEOUT_MS = ceilingOf("timeout.syslog_ms");

/**
 * The collector this process sends to, said once at its start. Kept here
 * and not with the database handle: an event is recorded inside
 * transactions, which are other handles.
 */
let watched: SyslogCollector | undefined;

export function watchSyslog(collector: SyslogCollector | undefined): void {
  watched = collector;
}

/** One RFC 5424 line: facility local0, severity notice, a JSON message. */
export function formatSyslogLine(
  payload: CollectorPayload,
  host: string = hostname(),
): string {
  const body = JSON.stringify({ source: "anygriddb", ...payload });
  return syslogLine("auth", payload.occurredAt, body, host);
}

/** One RFC 5424 line of this message id, its message a JSON text. */
function syslogLine(
  messageId: "auth" | "trail",
  at: string,
  body: string,
  host: string = hostname(),
): string {
  // A header field holds no space: a host name never should, but is given.
  const name = host.replace(/[^\x21-\x7e]/g, "_").slice(0, 255) || "-";
  return `<133>1 ${at} ${name} anygriddb - ${messageId} - ${body}`;
}

/** A batch of the change trail as one syslog line (ADR 0120). */
export function formatTrailLine(
  body: string,
  at: string,
  host: string = hostname(),
): string {
  return syslogLine("trail", at, body, host);
}

/**
 * Sends one line, counted in octets (RFC 6587), once the collector's
 * certificate is verified for its name against the system's authorities
 * and the operator's (`outbound/tls-frame.ts`). Any failure rejects, and
 * nothing was sent in clear.
 */
export function sendSyslogLine(
  collector: SyslogCollector,
  line: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
  lookup?: LookupFunction,
): Promise<void> {
  return sendTlsFrame(
    collector,
    `${String(Buffer.byteLength(line))} ${line}`,
    timeoutMs,
    lookup,
  );
}

/** A host name or an address, as the environment's own is read. */
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;
const PEM = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;

export const syslogUpdateSchema = z
  .object({
    host: z
      .string()
      .trim()
      .regex(HOST)
      .transform((host) => host.toLowerCase()),
    port: z.number().int().min(1).max(65_535).default(6514),
    /**
     * The authority that signed the collector's certificate, when it is
     * not one the system knows. Left out, the one saved is kept; null
     * forgets it.
     */
    ca: z.string().trim().max(65_536).regex(PEM).nullable().optional(),
  })
  .strict();

type SyslogUpdate = z.infer<typeof syslogUpdateSchema>;

/** The collector in force, and who named it. */
type NamedCollector = {
  collector: SyslogCollector;
  source: "environment" | "administration";
};

type PublicSyslog =
  | { configured: false; saved: boolean }
  | {
      configured: true;
      source: NamedCollector["source"];
      host: string;
      port: number;
      /** That an authority was given, never the certificate itself. */
      ownAuthority: boolean;
      /** A collector is saved in Administration, in force or not. */
      saved: boolean;
    };

async function loadSyslogRow(db: Database): Promise<SyslogCollector | null> {
  const row = await db
    .selectFrom("instanceSyslog")
    .select(["host", "port", "ca"])
    .where("id", "=", true)
    .executeTakeFirst();
  if (!row) return null;
  return { host: row.host, port: row.port, ...(row.ca ? { ca: row.ca } : {}) };
}

/**
 * The environment's collector when it names one (ADR 0083), else the one
 * saved in Administration, else none.
 */
async function resolveSyslog(
  db: Database,
  fromEnvironment: SyslogCollector | undefined,
): Promise<NamedCollector | null> {
  if (fromEnvironment) {
    return { collector: fromEnvironment, source: "environment" };
  }
  const saved = await loadSyslogRow(db);
  return saved ? { collector: saved, source: "administration" } : null;
}

/** What Administration shows of the collector: never a certificate. */
export async function publicSyslog(
  db: Database,
  fromEnvironment: SyslogCollector | undefined,
): Promise<PublicSyslog> {
  const saved = (await loadSyslogRow(db)) !== null;
  const named = await resolveSyslog(db, fromEnvironment);
  if (!named) return { configured: false, saved };
  return {
    configured: true,
    source: named.source,
    host: named.collector.host,
    port: named.collector.port,
    ownAuthority: named.collector.ca !== undefined,
    saved,
  };
}

/**
 * Refuses a collector an administrator may not name: an address of the
 * machine itself or of a cloud's metadata, ever, and one of a private
 * network unless an administrator allowed those (ADR 0092).
 */
export async function assertCollectorAllowed(
  collector: SyslogCollector,
  allowPrivate: boolean,
  resolve?: OutboundResolve,
): Promise<void> {
  const host =
    isIP(collector.host) === 6 ? `[${collector.host}]` : collector.host;
  try {
    await assertOutboundTarget(`https://${host}:${String(collector.port)}/`, {
      allowPrivate,
      ...(resolve ? { resolve } : {}),
    });
  } catch (error) {
    throw new AppError("invalid_syslog_target", { cause: error });
  }
}

/**
 * How a collector is reached: the network's own way, or a stand-in in
 * tests, whose collector listens on the loopback no administrator may
 * name.
 */
export type SyslogReach = {
  resolve?: OutboundResolve;
  send?: typeof sendSyslogLine;
};

/**
 * Sends a line to the collector in force. The environment's is the
 * operator's word and is reached as named; one saved in Administration is
 * checked again, and the connection goes to the address that was checked.
 */
async function sendToCollector(
  db: Database,
  named: NamedCollector,
  line: string,
  reach: SyslogReach = {},
): Promise<void> {
  const send = reach.send ?? sendSyslogLine;
  if (named.source === "environment") {
    await send(named.collector, line);
    return;
  }
  const allowPrivate = await relaxationAllows(db, "notify.private_networks");
  await assertCollectorAllowed(named.collector, allowPrivate, reach.resolve);
  await send(
    named.collector,
    line,
    SEND_TIMEOUT_MS,
    outboundLookup(allowPrivate),
  );
}

function testLine(actorId: string): string {
  return formatSyslogLine({
    action: "settings_changed",
    userId: null,
    actorId,
    method: "admin",
    detail: "syslog",
    ip: null,
    occurredAt: new Date().toISOString(),
  });
}

/**
 * Saves the collector, once it took an event sent with these settings: a
 * mistyped host or a certificate it cannot verify is said now, not at the
 * first event lost. Refused while the environment names one.
 */
export async function saveSyslog(
  db: Database,
  fromEnvironment: SyslogCollector | undefined,
  userId: string,
  input: SyslogUpdate,
  options: { ip?: string; reach?: SyslogReach } = {},
): Promise<PublicSyslog> {
  if (fromEnvironment) throw new AppError("set_by_environment");
  const ca = input.ca === undefined ? (await loadSyslogRow(db))?.ca : input.ca;
  const collector: SyslogCollector = {
    host: input.host,
    port: input.port,
    ...(ca ? { ca } : {}),
  };
  try {
    await sendToCollector(
      db,
      { collector, source: "administration" },
      testLine(userId),
      options.reach,
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("syslog_unreachable", { cause: error });
  }
  const row = {
    id: true as const,
    host: collector.host,
    port: collector.port,
    ca: collector.ca ?? null,
    updatedBy: userId,
    updatedAt: new Date(),
  };
  await db
    .insertInto("instanceSyslog")
    .values(row)
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        host: row.host,
        port: row.port,
        ca: row.ca,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      }),
    )
    .execute();
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "syslog",
    ip: options.ip,
  });
  return publicSyslog(db, fromEnvironment);
}

/** Forgets the collector saved in Administration, in force or not. */
export async function clearSyslog(
  db: Database,
  userId: string,
  ip?: string,
): Promise<void> {
  await db.deleteFrom("instanceSyslog").where("id", "=", true).execute();
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "syslog",
    ip,
  });
}

/** Queues one event for the collector, when the instance has one. */
export async function queueSyslogEvent(
  db: Database,
  event: CollectorEvent,
): Promise<void> {
  const payload = collectorPayload(event);
  if (!payload) return;
  if (!watched && !(await loadSyslogRow(db))) return;
  await addJob(db, TASKS.syslogEvent, payload, { maxAttempts: 5 });
}

/**
 * The worker's delivery. A failure is thrown for the queue to try again;
 * it names no host: the collector's address is not the log's to keep.
 */
export async function deliverSyslogEvent(
  db: Database,
  fromEnvironment: SyslogCollector | undefined,
  payload: CollectorPayload,
  reach?: SyslogReach,
): Promise<void> {
  const named = await resolveSyslog(db, fromEnvironment);
  // No longer named since the event was queued: nothing to do.
  if (!named) return;
  try {
    await sendToCollector(db, named, formatSyslogLine(payload), reach);
  } catch (error) {
    throw new AppError("invalid_delivery", "syslog", { cause: error });
  }
}

/**
 * Sends a batch of the change trail to the collector in force (ADR 0120).
 * Answers false when none is named; a failure is thrown, naming no host.
 */
export async function sendTrailToSyslog(
  db: Database,
  fromEnvironment: SyslogCollector | undefined,
  body: string,
  reach?: SyslogReach,
): Promise<boolean> {
  const named = await resolveSyslog(db, fromEnvironment);
  if (!named) return false;
  const line = formatTrailLine(body, new Date().toISOString());
  try {
    await sendToCollector(db, named, line, reach);
  } catch (error) {
    throw new AppError("invalid_delivery", "syslog", { cause: error });
  }
  return true;
}

/** Whether a syslog collector is named, by the environment or here. */
export async function syslogNamed(
  db: Database,
  fromEnvironment: SyslogCollector | undefined,
): Promise<boolean> {
  return (await resolveSyslog(db, fromEnvironment)) !== null;
}

/** One event sent now, for Administration's test: refused when it fails. */
export async function sendSyslogTest(
  db: Database,
  fromEnvironment: SyslogCollector | undefined,
  actorId: string,
  reach?: SyslogReach,
): Promise<void> {
  const named = await resolveSyslog(db, fromEnvironment);
  if (!named) throw new AppError("not_found");
  try {
    await sendToCollector(db, named, testLine(actorId), reach);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("syslog_unreachable", { cause: error });
  }
}
