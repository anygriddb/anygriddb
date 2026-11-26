/**
 * JSON over HTTPS to a store that is read through a REST API (ADR 0088),
 * part of the outbound service as every connection the instance opens:
 * Node's own client, the certificate verified against the authority the
 * source gives or the system's, every request under the source's time
 * limit. A redirect is not followed: the operator's list of hosts holds
 * for every address reached.
 */
import http from "node:http";
import https from "node:https";
import { AppError, ceilingOf } from "@anygriddb/core";
import type { SourceConnection } from "../sources/types.js";
import { connectionError } from "../sources/copy/errors.js";
import type { ConnectOptions } from "../sources/copy/types.js";

/** An answer larger than this is not read: a page of rows is far smaller. */
const MAX_ANSWER_BYTES = ceilingOf("copy.answer_bytes");

export type HttpAnswer = { status: number; body: unknown };

export type HttpStore = {
  /** One request; the answer whatever its status, parsed when it is JSON. */
  request(method: string, path: string, body?: unknown): Promise<HttpAnswer>;
  /** Closes the connections kept open between requests. */
  close(): void;
};

/** What the JSON parser says of the number it just read. */
type ParsedFrom = { source?: string };

/** A whole number a double cannot hold stays its digits, as MongoDB's does. */
function keepWhole(_key: string, value: unknown, from?: ParsedFrom): unknown {
  return typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    from?.source !== undefined &&
    /^-?\d+$/.test(from.source)
    ? from.source
    : value;
}

/** An answer's JSON; null for one that is not JSON, which tells its status only. */
export function parsedJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    // Only an answer holding a number that long pays for the reviver.
    return /\d{16}/.test(text)
      ? (JSON.parse(text, keepWhole as never) as unknown)
      : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function openHttp(
  source: SourceConnection,
  options: ConnectOptions,
): HttpStore {
  const agent = options.allowPlaintext
    ? new http.Agent({ keepAlive: true, maxSockets: 2 })
    : new https.Agent({
        keepAlive: true,
        maxSockets: 2,
        rejectUnauthorized: true,
        ...(source.tlsCa ? { ca: source.tlsCa } : {}),
      });
  const client = options.allowPlaintext ? http : https;
  const authorization = `Basic ${Buffer.from(
    `${source.username}:${source.password}`,
    "utf8",
  ).toString("base64")}`;

  const request = (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpAnswer> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const call = client.request(
        {
          agent,
          host: source.host,
          port: source.port,
          method,
          path,
          timeout: source.queryTimeoutMs,
          headers: {
            accept: "application/json",
            authorization,
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ANSWER_BYTES) {
              call.destroy(new AppError("source_query_failed"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            clearTimeout(deadline);
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: response.statusCode ?? 0,
              body: parsedJson(text),
            });
          });
        },
      );
      // The socket's limit is between two packets: a server that sends a
      // byte now and then would keep it open. The whole answer has one too.
      const deadline = setTimeout(() => {
        call.destroy(new AppError("source_timeout"));
      }, source.queryTimeoutMs);
      call.on("close", () => {
        clearTimeout(deadline);
      });
      call.on("timeout", () => {
        call.destroy(new AppError("source_timeout"));
      });
      call.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      call.end(payload);
    });

  return {
    request: (method, path, body) =>
      request(method, path, body).catch((error: unknown) => {
        throw (
          connectionError(error) ??
          new AppError("source_unreachable", { cause: error })
        );
      }),
    close: () => {
      agent.destroy();
    },
  };
}
