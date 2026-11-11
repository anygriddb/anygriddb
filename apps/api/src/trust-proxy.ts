import type { FastifyServerOptions } from "fastify";

/**
 * Who may set the client address. With no proxy configured, the TCP peer
 * is the client: a request cannot pick its own address. Otherwise the
 * client is the nearest address that is not one of the proxies named, by
 * address or by range.
 */
export function trustProxy(
  proxies: readonly string[],
): FastifyServerOptions["trustProxy"] {
  return proxies.length === 0 ? false : [...proxies];
}
