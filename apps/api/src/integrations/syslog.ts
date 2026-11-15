/**
 * Sign-in trail events sent to a syslog collector (ADR 0084): the events
 * the HTTPS collector gets (ADR 0056), from the queue, tried again when
 * the collector is away, over TLS with its certificate verified (RFC
 * 5425). Never in clear text, never from the request that made the event.
 *
 * The collector is named where the instance is installed (`SYSLOG_HOST`):
 * it sits on the operator's network, and which hosts of that network the
 * instance connects to is the operator's to say.
 */
import { isIP } from "node:net";
import { hostname } from "node:os";
import { connect, rootCertificates } from "node:tls";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { SyslogCollector } from "../env.js";
import { addJob, TASKS } from "../queue/jobs.js";
import {
  type CollectorEvent,
  type CollectorPayload,
  collectorPayload,
} from "./siem.js";

/** Connecting, the handshake and the write, together. */
const SEND_TIMEOUT_MS = 5_000;

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
  // A header field holds no space: a host name never should, but is given.
  const name = host.replace(/[^\x21-\x7e]/g, "_").slice(0, 255) || "-";
  const body = JSON.stringify({ source: "anygriddb", ...payload });
  return `<133>1 ${payload.occurredAt} ${name} anygriddb - auth - ${body}`;
}

/**
 * Sends one line, counted in octets (RFC 6587), once the collector's
 * certificate is verified for its name against the system's authorities
 * and the operator's. Any failure rejects, and nothing was sent in clear.
 */
export function sendSyslogLine(
  collector: SyslogCollector,
  line: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<void> {
  const frame = `${String(Buffer.byteLength(line))} ${line}`;
  return new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: collector.host,
      port: collector.port,
      // An address has no name to send; its certificate must list it.
      servername: isIP(collector.host) === 0 ? collector.host : undefined,
      ca: collector.ca ? [...rootCertificates, collector.ca] : undefined,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    // One limit for the whole exchange: a collector that accepts the
    // connection and then stops answering does not hold a worker.
    const timer = setTimeout(() => {
      fail(new Error("syslog collector timed out"));
    }, timeoutMs);
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.end(frame);
    });
    socket.once("close", (hadError) => {
      clearTimeout(timer);
      if (!hadError) resolve();
    });
  });
}

/** Queues one event for the collector, when this process has one. */
export async function queueSyslogEvent(
  db: Database,
  event: CollectorEvent,
): Promise<void> {
  if (!watched) return;
  const payload = collectorPayload(event);
  if (!payload) return;
  await addJob(db, TASKS.syslogEvent, payload, { maxAttempts: 5 });
}

/**
 * The worker's delivery. A failure is thrown for the queue to try again;
 * it names no host: the collector's address is the operator's.
 */
export async function deliverSyslogEvent(
  collector: SyslogCollector | undefined,
  payload: CollectorPayload,
): Promise<void> {
  // Taken out of the environment since the event was queued: nothing to do.
  if (!collector) return;
  try {
    await sendSyslogLine(collector, formatSyslogLine(payload));
  } catch (error) {
    throw new AppError("invalid_delivery", "syslog", { cause: error });
  }
}

/** One event sent now, for Administration's test: refused when it fails. */
export async function sendSyslogTest(
  collector: SyslogCollector | undefined,
  actorId: string,
): Promise<void> {
  if (!collector) throw new AppError("not_found");
  const line = formatSyslogLine({
    action: "settings_changed",
    userId: null,
    actorId,
    method: "admin",
    detail: "syslog",
    ip: null,
    occurredAt: new Date().toISOString(),
  });
  try {
    await sendSyslogLine(collector, line);
  } catch (error) {
    throw new AppError("syslog_unreachable", { cause: error });
  }
}
