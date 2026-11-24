import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "@anygriddb/core";
import { isPrivateAddress, isReservedAddress } from "../special-addresses.js";

const METADATA_NAMES = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
]);

export type ResolvedAddress = { address: string; family: number };

/**
 * True when this address must not be contacted. A reserved address is
 * never reached; a private one only when an administrator has said so.
 */
export function isOutboundBlocked(
  address: string,
  family: number,
  allowPrivate: boolean,
): boolean {
  if (isReservedAddress(address, family)) return true;
  return !allowPrivate && isPrivateAddress(address, family);
}

function hostName(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function refusedName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    METADATA_NAMES.has(host)
  );
}

function assertAddresses(
  addresses: readonly ResolvedAddress[],
  allowPrivate: boolean,
): void {
  if (
    addresses.length === 0 ||
    addresses.some((entry) =>
      isOutboundBlocked(entry.address, entry.family, allowPrivate),
    )
  ) {
    throw new AppError("invalid_outbound_target");
  }
}

export type OutboundResolve = (
  host: string,
) => Promise<readonly ResolvedAddress[]>;

async function resolvePublic(
  host: string,
): Promise<readonly ResolvedAddress[]> {
  const found = await lookup(host, { all: true, order: "verbatim" });
  return found.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));
}

/**
 * The URL an outgoing call may use (ADR 0125). HTTPS only, certificate
 * verified by the caller. A private address is allowed only when an
 * administrator has said so; a reserved one never is, including after
 * DNS. `resolve` is the DNS lookup: the default one, or a stand-in in
 * tests. A name that does not resolve is refused, the same as a private
 * one.
 */
export async function assertOutboundTarget(
  target: string,
  options: { allowPrivate: boolean; resolve?: OutboundResolve },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(target);
  } catch (error) {
    throw new AppError("invalid_outbound_target", { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppError("invalid_outbound_target");
  }
  const host = hostName(url);
  if (refusedName(host)) throw new AppError("invalid_outbound_target");
  const family = isIP(host);
  if (family !== 0) {
    assertAddresses([{ address: host, family }], options.allowPrivate);
    return url;
  }
  const resolve = options.resolve ?? resolvePublic;
  const addresses = await resolve(host).catch((error: unknown) => {
    throw new AppError("invalid_outbound_target", { cause: error });
  });
  assertAddresses(addresses, options.allowPrivate);
  return url;
}

/** One redirect, resolved against the URL that answered, then checked again. */
export function redirectTarget(current: URL, location: string): string {
  return new URL(location, current).href;
}

/**
 * The address a redirect may be followed to with this request's headers
 * and body, which can hold credentials: on the same origin only. Null
 * for any other, or for a location that is no address.
 */
export function redirectWithinOrigin(
  current: URL,
  location: string,
): string | null {
  if (!URL.canParse(location, current)) return null;
  const next = new URL(redirectTarget(current, location));
  return next.origin === current.origin ? next.href : null;
}
