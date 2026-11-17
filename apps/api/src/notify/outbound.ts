import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { AppError } from "@anygriddb/core";
import type { LookupFunction } from "node:net";
import {
  assertNotifyTarget,
  isNotifyBlocked,
  redirectTarget,
  type ResolvedAddress,
} from "./target.js";

const TIMEOUT_MS = 10_000;
const BODY_LIMIT = 2_048;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

export type OutboundRequest = {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string;
};

export type OutboundResponse = { status: number; body: string };

export type Outbound = (
  request: OutboundRequest,
  allowPrivate: boolean,
) => Promise<OutboundResponse>;

/** Strings long enough to be a credential, wherever they sit in a value. */
export function secretStrings(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 8 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(secretStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(secretStrings);
  }
  return [];
}

/** Replaces credential text before a response is shown or stored. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("••••");
  }
  return out.slice(0, BODY_LIMIT);
}

/**
 * A failure an administrator can read. The message of an unknown error
 * is not used: it often quotes the address, and some addresses are secrets.
 */
export function notifyFailureText(error: unknown): string {
  if (error instanceof AppError && error.code === "invalid_notify_target") {
    return "Blocked target";
  }
  if (error instanceof AppError && error.code === "notify_needs_mail") {
    return "Mail is not configured";
  }
  if (!(error instanceof Error)) return "Network error";
  if (error.message === "Timeout") return "Timeout";
  const code = (error as { code?: unknown }).code;
  if (code === "EBLOCKED") return "Blocked target";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Unknown host";
  if (code === "ECONNREFUSED") return "Connection refused";
  if (
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    (typeof code === "string" && code.startsWith("ERR_TLS"))
  ) {
    return "TLS error";
  }
  return "Network error";
}

/** DNS for the socket: the addresses checked are the ones it connects to. */
export function notifyLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(
      hostname,
      { all: true, order: "verbatim" },
      (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }
        const list = addresses as ResolvedAddress[];
        if (
          list.length === 0 ||
          list.some((entry) =>
            isNotifyBlocked(entry.address, entry.family, allowPrivate),
          )
        ) {
          callback(
            Object.assign(new Error("Blocked target"), { code: "EBLOCKED" }),
            "",
            0,
          );
          return;
        }
        if (typeof options === "object" && options.all) {
          callback(null, list);
          return;
        }
        const first = list[0];
        callback(null, first?.address ?? "", first?.family ?? 4);
      },
    );
  };
}

function readLimited(response: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      if (size >= BODY_LIMIT) return;
      const take = chunk.subarray(0, BODY_LIMIT - size);
      chunks.push(take);
      size += take.length;
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

function requestOnce(
  url: URL,
  method: OutboundRequest["method"],
  headers: Record<string, string>,
  body: string | undefined,
  allowPrivate: boolean,
): Promise<{ status: number; body: string; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = body ?? "";
    const outgoing = httpsRequest(
      url,
      {
        method,
        lookup: notifyLookup(allowPrivate),
        timeout: TIMEOUT_MS,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(payload)) }),
        },
      },
      (response) => {
        const raw: unknown = response.headers.location;
        const location = Array.isArray(raw)
          ? raw.find((item): item is string => typeof item === "string")
          : typeof raw === "string"
            ? raw
            : undefined;
        readLimited(response).then(
          (text) =>
            resolve({
              status: response.statusCode ?? 0,
              body: text,
              location,
            }),
          reject,
        );
      },
    );
    const timer = setTimeout(
      () => outgoing.destroy(new Error("Timeout")),
      TIMEOUT_MS,
    );
    outgoing.on("close", () => clearTimeout(timer));
    outgoing.on("timeout", () => outgoing.destroy(new Error("Timeout")));
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : payload);
  });
}

/** POST, PUT, or GET, one redirect at most, each hop checked again. */
export async function requestOutbound(
  call: OutboundRequest,
  allowPrivate: boolean,
): Promise<OutboundResponse> {
  const url = await assertNotifyTarget(call.url, { allowPrivate });
  const headers = call.headers ?? {};
  let response = await requestOnce(
    url,
    call.method,
    headers,
    call.body,
    allowPrivate,
  );
  if (
    REDIRECT.has(response.status) &&
    response.location &&
    response.location.length < 2_000
  ) {
    const next = await assertNotifyTarget(
      redirectTarget(url, response.location),
      { allowPrivate },
    );
    const get =
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303;
    response = await requestOnce(
      next,
      get ? "GET" : call.method,
      headers,
      get ? undefined : call.body,
      allowPrivate,
    );
  }
  return { status: response.status, body: response.body };
}
