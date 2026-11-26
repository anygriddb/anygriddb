import { lookup as dnsLookup } from "node:dns";
import {
  request as httpsRequest,
  type Agent as HttpsAgent,
  type RequestOptions,
} from "node:https";
import type { LookupFunction } from "node:net";
import { AppError, ceilingOf } from "@anygriddb/core";
import {
  assertOutboundTarget,
  isOutboundBlocked,
  redirectWithinOrigin,
  type OutboundResolve,
  type ResolvedAddress,
} from "./target.js";

export const OUTBOUND_TIMEOUT_MS = ceilingOf("timeout.outbound_ms");

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export type OutboundMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type OutboundCall = {
  url: string;
  method: OutboundMethod;
  headers?: Record<string, string>;
  body?: string;
  /** The most of an answer that is read. */
  maxBytes: number;
  /**
   * An answer longer than `maxBytes`: refused (the default), or cut there,
   * read to its end and the rest thrown away, for a caller that keeps only
   * its status and a few words of it to show.
   */
  tooLarge?: "refuse" | "cut";
  /** A private address only when an administrator has said so. */
  allowPrivate?: boolean;
  /** Authority PEM for verifying the peer (tests pin their own CA). */
  ca?: string | Buffer | Array<string | Buffer>;
  /** DNS used when asserting the target (tests). */
  resolve?: OutboundResolve;
  /**
   * DNS used for the socket. Defaults to one that re-checks the same
   * rules, so a name cannot resolve public at assert time and private
   * at connect time.
   */
  lookup?: LookupFunction;
  /**
   * Override how the socket is made (tests pin an agent that dials a
   * local listener while lookup still claims a public address).
   */
  agent?: HttpsAgent | false;
  createConnection?: RequestOptions["createConnection"];
  timeoutMs?: number;
};

export type OutboundAnswer = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/**
 * A lookup that only yields addresses already checked. Tests pin a list
 * that stands for what DNS returned at connect time (rebinding).
 */
export function lookupAddresses(
  addresses: readonly ResolvedAddress[],
  allowPrivate: boolean,
): LookupFunction {
  return (_hostname, options, callback) => {
    if (
      addresses.length === 0 ||
      addresses.some((entry) =>
        isOutboundBlocked(entry.address, entry.family, allowPrivate),
      )
    ) {
      callback(
        Object.assign(new AppError("invalid_outbound_target"), {
          code: "EBLOCKED",
        }),
        "",
        0,
      );
      return;
    }
    if (typeof options === "object" && options.all) {
      callback(null, [...addresses]);
      return;
    }
    const first = addresses[0];
    callback(null, first?.address ?? "", first?.family ?? 4);
  };
}

/**
 * DNS for the socket: the addresses checked are the ones it connects to.
 */
export function outboundLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(
      hostname,
      { all: true, order: "verbatim" },
      (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }
        lookupAddresses(addresses, allowPrivate)(hostname, options, callback);
      },
    );
  };
}

function readLimited(
  response: NodeJS.ReadableStream,
  limit: { maxBytes: number; cut: boolean },
  abort: (error: Error) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      abort(error);
      reject(error);
    };
    response.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (limit.cut) {
        const kept = chunk.subarray(0, Math.max(0, limit.maxBytes - size));
        size += kept.length;
        if (kept.length > 0) chunks.push(kept);
        return;
      }
      size += chunk.length;
      if (size > limit.maxBytes) {
        fail(new Error("Answer too large"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    response.on("error", (error: Error) => fail(error));
  });
}

function collectHeaders(
  raw: NodeJS.Dict<string | string[] | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || Object.keys(headers).length >= 50) continue;
    headers[name] = (Array.isArray(value) ? value.join(", ") : value).slice(
      0,
      2_000,
    );
  }
  return headers;
}

type OnceResult = OutboundAnswer & { location: string | undefined };

function requestOnce(
  url: URL,
  call: OutboundCall,
  allowPrivate: boolean,
): Promise<OnceResult> {
  const timeoutMs = call.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  const body = call.body;
  const headers = call.headers ?? {};
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      url,
      {
        method: call.method,
        lookup: call.lookup ?? outboundLookup(allowPrivate),
        ...(call.agent !== undefined ? { agent: call.agent } : {}),
        ...(call.createConnection
          ? { agent: false as const, createConnection: call.createConnection }
          : {}),
        ca: call.ca,
        timeout: timeoutMs,
        servername: url.hostname,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (response) => {
        const raw: unknown = response.headers.location;
        const location = Array.isArray(raw)
          ? raw.find((item): item is string => typeof item === "string")
          : typeof raw === "string"
            ? raw
            : undefined;
        readLimited(
          response,
          { maxBytes: call.maxBytes, cut: call.tooLarge === "cut" },
          (error) => outgoing.destroy(error),
        ).then(
          (text) =>
            resolve({
              status: response.statusCode ?? 0,
              headers: collectHeaders(response.headers),
              body: text,
              location,
            }),
          reject,
        );
      },
    );
    const timer = setTimeout(
      () => outgoing.destroy(new Error("Timeout")),
      timeoutMs,
    );
    outgoing.on("close", () => clearTimeout(timer));
    outgoing.on("timeout", () => outgoing.destroy(new Error("Timeout")));
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : body);
  });
}

/**
 * The request a redirect is followed with, or null when it is not. A 307
 * or a 308 keeps the method and the body. A 301, 302 or 303 turns the
 * request into a GET without its body, so only a GET or a HEAD follows
 * it: a POST that was answered with one was not delivered, and saying the
 * page it points at answered would claim it was.
 */
function followWith(status: number, call: OutboundCall): OutboundCall | null {
  if (status === 307 || status === 308) return call;
  if (call.method === "GET" || call.method === "HEAD") {
    return { ...call, method: "GET", body: undefined };
  }
  return null;
}

/**
 * One HTTPS request, address pinned against SSRF and DNS rebinding, at
 * most one redirect on the same origin (checked again), body capped,
 * timed out. The certificate is verified (ADR 0030, 0125).
 */
export async function requestOutbound(
  call: OutboundCall,
): Promise<OutboundAnswer> {
  const allowPrivate = call.allowPrivate === true;
  const url = await assertOutboundTarget(call.url, {
    allowPrivate,
    resolve: call.resolve,
  });
  let response = await requestOnce(url, call, allowPrivate);
  const follow = REDIRECT.has(response.status)
    ? followWith(response.status, call)
    : null;
  if (follow && response.location && response.location.length < 2_000) {
    const within = redirectWithinOrigin(url, response.location);
    if (within !== null) {
      const next = await assertOutboundTarget(within, {
        allowPrivate,
        resolve: call.resolve,
      });
      response = await requestOnce(
        next,
        { ...follow, url: within },
        allowPrivate,
      );
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
  };
}

/**
 * Posts a body and answers the status, as a delivery needs: the answer's
 * text is read to its end and not kept.
 */
export async function postOutbound(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const answer = await requestOutbound({
    url,
    method: "POST",
    headers,
    body,
    maxBytes: 0,
    tooLarge: "cut",
  });
  return answer.status;
}
