/**
 * Recent lines of this process, for Administration (ADR 0087).
 *
 * The container's output is unchanged: a collector still reads every line
 * there. This ring keeps a second, smaller copy in memory, and the page
 * reads only the fields a line is allowed to show. It is empty after a
 * restart, and it is this process's copy alone.
 */
import { Writable } from "node:stream";
import { serializeError } from "./logged-error.js";
import { logUrl } from "./log-url.js";
import { stripCrlf } from "./http.js";

const DEFAULT_MAX_LINES = 500;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_MESSAGE = 500;
const MAX_STACK = 4_000;
const MAX_URL = 500;

/** A name or a code: short, and made of nothing a value is made of. */
const TOKEN = /^[\w.:-]{1,64}$/;
const METHOD = /^[A-Z]{1,10}$/;
const ADDRESS = /^[0-9a-fA-F:.]+$/;

const INCOMING = "incoming request";
const COMPLETED = "request completed";

export type ProcessLogLevel = "info" | "warn" | "error";

export type ProcessLogFailure = {
  type: string;
  code?: string;
  constraint?: string;
  stack?: string;
  cause?: ProcessLogFailure;
};

export type ProcessLogLine = {
  seq: number;
  time: string;
  level: "info" | "warn" | "error" | "fatal";
  message: string;
  /** An application code a refusal was logged with, when it is one. */
  code?: string;
  status?: number;
  request?: {
    method: string;
    url: string;
    remoteAddress?: string;
  };
  error?: ProcessLogFailure;
  /** A page that failed in a browser: kind, path, and its own message. */
  client?: {
    kind: string;
    path: string;
    message?: string;
    stack?: string;
  };
};

type Stored = {
  bytes: number;
  level: number;
  line: ProcessLogLine;
};

export type ProcessLog = {
  /** One chunk of the serialized log, which may hold part of a line. */
  capture(chunk: string | Buffer): void;
  /** A failure that is written beside the logger (the pool, the bus). */
  rememberFailure(message: string, error: unknown): void;
  /** Newest first, at this level and above. */
  list(options: { level: ProcessLogLevel; limit: number }): ProcessLogLine[];
};

/**
 * The destination the server's logger writes: the container's output, and
 * the ring. A bad line is ignored; it never stops the log.
 */
export function logDestination(log: ProcessLog = processLog): Writable {
  return new Writable({
    write(chunk, encoding, callback) {
      try {
        log.capture(Buffer.isBuffer(chunk) ? chunk : String(chunk));
      } catch {
        // The ring is a copy. The output below is the log that must leave.
      }
      if (Buffer.isBuffer(chunk)) {
        process.stdout.write(chunk, callback);
        return;
      }
      process.stdout.write(String(chunk), encoding, callback);
    },
  });
}

/** Lines kept apart from the others, each set under its own limits. */
type Ring = { stored: Stored[]; bytes: number };

export function createProcessLog(limits?: {
  maxLines?: number;
  maxBytes?: number;
}): ProcessLog {
  const maxLines = limits?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  // Warnings and failures are kept apart from the process's ordinary
  // messages and refused requests: a burst of 404s from a scanner must not
  // push out the failure the page exists to show.
  const failures: Ring = { stored: [], bytes: 0 };
  const ordinary: Ring = { stored: [], bytes: 0 };
  let seq = 0;
  let pending = "";

  const push = (level: number, line: ProcessLogLine) => {
    const ring = level >= 40 ? failures : ordinary;
    const size = JSON.stringify(line).length;
    ring.stored.push({ bytes: size, level, line });
    ring.bytes += size;
    while (
      (ring.stored.length > maxLines || ring.bytes > maxBytes) &&
      ring.stored.length > 1
    ) {
      const oldest = ring.stored.shift();
      if (oldest) ring.bytes -= oldest.bytes;
    }
  };

  const ingest = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const kept = keep(parsed as Record<string, unknown>, () => {
      seq += 1;
      return seq;
    });
    if (kept) push(kept.level, kept.line);
  };

  return {
    capture(chunk) {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // A chunk that never ends a line is not a log line.
      if (pending.length > 1_000_000) pending = pending.slice(-1_000);
      let end = pending.indexOf("\n");
      while (end !== -1) {
        const text = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (text) ingest(text);
        end = pending.indexOf("\n");
      }
    },
    rememberFailure(message, error) {
      ingest(
        JSON.stringify({
          level: 50,
          time: Date.now(),
          msg: message,
          ...(error === undefined || error === null
            ? {}
            : { err: serializeError(error) }),
        }),
      );
    },
    list(options) {
      const min =
        options.level === "error" ? 50 : options.level === "warn" ? 40 : 30;
      const matched =
        min >= 40
          ? failures.stored.filter((item) => item.level >= min)
          : mergeBySeq(failures.stored, ordinary.stored);
      return matched
        .slice(-options.limit)
        .reverse()
        .map((item) => item.line);
    },
  };
}

/** Two sets of lines, each oldest first, as one, oldest first. */
function mergeBySeq(
  left: readonly Stored[],
  right: readonly Stored[],
): Stored[] {
  const merged: Stored[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const a = left[i];
    const b = right[j];
    if (a && (!b || a.line.seq < b.line.seq)) {
      merged.push(a);
      i += 1;
    } else if (b) {
      merged.push(b);
      j += 1;
    }
  }
  return merged;
}

/** The one ring of this process. */
export const processLog = createProcessLog();

function keep(
  raw: Record<string, unknown>,
  nextSeq: () => number,
): { level: number; line: ProcessLogLine } | undefined {
  const level =
    typeof raw.level === "number" && Number.isFinite(raw.level)
      ? raw.level
      : undefined;
  const message = text(raw.msg, MAX_MESSAGE);
  if (level === undefined || message === undefined) return undefined;
  if (level < 30) return undefined;
  if (level < 40) {
    if (message === INCOMING) return undefined;
    if (message === COMPLETED) {
      const status = statusOf(raw);
      if (status === undefined || status < 400) return undefined;
    }
  }
  const line: ProcessLogLine = {
    seq: nextSeq(),
    time: timeOf(raw.time),
    level: levelName(level),
    message,
  };
  const code = token(raw.code);
  if (code) line.code = code;
  const status = statusOf(raw);
  if (status !== undefined) line.status = status;
  const request = requestOf(raw.req);
  if (request) line.request = request;
  const error = failureOf(raw.err, 0);
  if (error) line.error = error;
  const client = clientOf(raw.client);
  if (client) line.client = client;
  return { level, line };
}

function levelName(level: number): ProcessLogLine["level"] {
  if (level >= 60) return "fatal";
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  return "info";
}

function timeOf(value: unknown): string {
  const ms =
    typeof value === "number" && Number.isFinite(value) ? value : Date.now();
  const date = new Date(ms);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

/** One line: a break becomes a space, so a value cannot forge a second line. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, max);
}

function token(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

/** A property read as unknown: `Reflect.get` is typed as any. */
function field(source: object, name: string): unknown {
  const value: unknown = Reflect.get(source, name);
  return value;
}

function statusOf(raw: Record<string, unknown>): number | undefined {
  const direct = raw.status;
  if (typeof direct === "number" && httpStatus(direct)) return direct;
  const res = raw.res;
  if (res === null || typeof res !== "object") return undefined;
  const code = field(res, "statusCode");
  return typeof code === "number" && httpStatus(code) ? code : undefined;
}

function httpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status < 600;
}

function requestOf(value: unknown): ProcessLogLine["request"] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const method = field(value, "method");
  const url = field(value, "url");
  if (typeof method !== "string" || !METHOD.test(method)) return undefined;
  if (typeof url !== "string") return undefined;
  const request: NonNullable<ProcessLogLine["request"]> = {
    method,
    url: logUrl(stripCrlf(url)).slice(0, MAX_URL),
  };
  const address = field(value, "remoteAddress");
  if (
    typeof address === "string" &&
    ADDRESS.test(address) &&
    address.length <= 64
  ) {
    request.remoteAddress = address;
  }
  return request;
}

function failureOf(
  value: unknown,
  depth: number,
): ProcessLogFailure | undefined {
  if (value === null || typeof value !== "object" || depth > 3)
    return undefined;
  const type = token(field(value, "type")) ?? token(field(value, "name"));
  if (!type) return undefined;
  const failure: ProcessLogFailure = { type };
  const code = token(field(value, "code"));
  if (code) failure.code = code;
  const constraint = token(field(value, "constraint"));
  if (constraint) failure.constraint = constraint;
  const stack = frames(field(value, "stack"));
  if (stack) failure.stack = stack;
  const cause = failureOf(field(value, "cause"), depth + 1);
  if (cause) failure.cause = cause;
  return failure;
}

/** Frames only: the first line of a stack is the message, which quotes a value. */
function frames(value: unknown): string | undefined {
  const source = Array.isArray(value)
    ? value.filter((line) => typeof line === "string").join("\n")
    : value;
  if (typeof source !== "string") return undefined;
  const lines = source.split("\n").filter((line) => /^\s*at /.test(line));
  if (lines.length === 0) return undefined;
  return lines.join("\n").slice(0, MAX_STACK);
}

function clientOf(value: unknown): ProcessLogLine["client"] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const kind = token(field(value, "kind"));
  const path = text(field(value, "path"), MAX_URL);
  if (!kind || path === undefined) return undefined;
  const client: NonNullable<ProcessLogLine["client"]> = {
    kind,
    path: logUrl(path).slice(0, MAX_URL),
  };
  const message = text(field(value, "message"), MAX_MESSAGE);
  if (message) client.message = message;
  const stack = frames(field(value, "stack"));
  if (stack) client.stack = stack;
  return client;
}
