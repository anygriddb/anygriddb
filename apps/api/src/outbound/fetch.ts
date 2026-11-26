/**
 * The outbound service as a `fetch`, for a library that takes one (an
 * OpenID client, a key set): every call it makes is one `requestOutbound`,
 * with its address checked, its answer capped and its time bounded.
 */
import {
  type OutboundCall,
  requestOutbound,
  type OutboundMethod,
} from "./request.js";

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
]);

/** Statuses whose answer has no body, which a `Response` refuses one for. */
const EMPTY: ReadonlySet<number> = new Set([101, 204, 205, 304]);

export type OutboundFetchOptions = {
  /** A private address only when an administrator has named the target. */
  allowPrivate: boolean;
  /** The most of an answer that is read. */
  maxBytes: number;
  timeoutMs?: number;
  /** How a test reaches its own listener as a public host. */
  through?: Pick<OutboundCall, "ca" | "resolve" | "lookup" | "agent">;
};

/** A `fetch` whose every call goes through the outbound service. */
export function outboundFetch(options: OutboundFetchOptions): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (!METHODS.has(request.method)) {
      throw new TypeError(`${request.method} is not sent out`);
    }
    const body = request.body === null ? undefined : await request.text();
    const sent = requestOutbound({
      url: request.url,
      method: request.method as OutboundMethod,
      headers: Object.fromEntries(request.headers),
      ...(body === undefined ? {} : { body }),
      maxBytes: options.maxBytes,
      allowPrivate: options.allowPrivate,
      ...options.through,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    const answer = await (request.signal.aborted
      ? Promise.reject(request.signal.reason as Error)
      : new Promise<Awaited<typeof sent>>((resolve, reject) => {
          const stop = () => reject(request.signal.reason as Error);
          request.signal.addEventListener("abort", stop, { once: true });
          sent.then(resolve, reject).finally(() => {
            request.signal.removeEventListener("abort", stop);
          });
        }));
    return new Response(EMPTY.has(answer.status) ? null : answer.body, {
      status: answer.status,
      headers: answer.headers,
    });
  };
}
