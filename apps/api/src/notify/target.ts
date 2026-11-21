import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { AppError } from "@anygriddb/core";

/**
 * Where a notification may be sent (ADR 0092, 0030). HTTPS only, and the
 * certificate is verified by the caller. A private address is allowed
 * only when an administrator has said so. Loopback, link-local, carrier
 * NAT, and cloud metadata never are, including after DNS.
 */
const ALWAYS = new BlockList();
ALWAYS.addSubnet("0.0.0.0", 8, "ipv4");
ALWAYS.addSubnet("100.64.0.0", 10, "ipv4");
ALWAYS.addSubnet("127.0.0.0", 8, "ipv4");
ALWAYS.addSubnet("169.254.0.0", 16, "ipv4");
ALWAYS.addSubnet("224.0.0.0", 4, "ipv4");
ALWAYS.addSubnet("240.0.0.0", 4, "ipv4");
ALWAYS.addAddress("::", "ipv6");
ALWAYS.addAddress("::1", "ipv6");
ALWAYS.addSubnet("64:ff9b::", 96, "ipv6");
ALWAYS.addSubnet("64:ff9b:1::", 48, "ipv6");
ALWAYS.addSubnet("2001:0::", 32, "ipv6");
ALWAYS.addSubnet("2002::", 16, "ipv6");
ALWAYS.addSubnet("fe80::", 10, "ipv6");
ALWAYS.addSubnet("ff00::", 8, "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");

const METADATA_NAMES = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
]);

export type ResolvedAddress = { address: string; family: number };

/** The IPv4 address inside `::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`, if any. */
function mappedIpv4(address: string): string | null {
  const match = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(address);
  if (!match?.[1]) return null;
  const rest = match[1];
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function blocked(list: BlockList, address: string, family: number): boolean {
  if (family === 6) {
    const inner = mappedIpv4(address);
    if (inner) return list.check(inner, "ipv4");
  }
  return list.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** True when this address must not be contacted, even on a private network. */
export function isNotifyBlocked(
  address: string,
  family: number,
  allowPrivate: boolean,
): boolean {
  if (blocked(ALWAYS, address, family)) return true;
  return !allowPrivate && blocked(PRIVATE, address, family);
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
      isNotifyBlocked(entry.address, entry.family, allowPrivate),
    )
  ) {
    throw new AppError("invalid_notify_target");
  }
}

export type NotifyResolve = (
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
 * The URL a notification may use. `resolve` is the DNS lookup: the
 * default one, or a stand-in in tests. A name that does not resolve is
 * refused, the same as a private one.
 */
export async function assertNotifyTarget(
  target: string,
  options: { allowPrivate: boolean; resolve?: NotifyResolve },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(target);
  } catch (error) {
    throw new AppError("invalid_notify_target", { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppError("invalid_notify_target");
  }
  const host = hostName(url);
  if (refusedName(host)) throw new AppError("invalid_notify_target");
  const family = isIP(host);
  if (family !== 0) {
    assertAddresses([{ address: host, family }], options.allowPrivate);
    return url;
  }
  const resolve = options.resolve ?? resolvePublic;
  const addresses = await resolve(host).catch((error: unknown) => {
    throw new AppError("invalid_notify_target", { cause: error });
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
 * and body, which can hold a channel's credentials: on the same origin
 * only. Null for any other, or for a location that is no address.
 */
export function redirectWithinOrigin(
  current: URL,
  location: string,
): string | null {
  if (!URL.canParse(location, current)) return null;
  const next = new URL(redirectTarget(current, location));
  return next.origin === current.origin ? next.href : null;
}
