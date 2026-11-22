import { BlockList, isIP } from "node:net";

/**
 * Addresses an outgoing request never reaches, whatever an administrator
 * allows: this machine, link-local, carrier NAT, cloud metadata, and the
 * ranges reserved for a special use. The three documentation ranges stay
 * out: they are not routed.
 */
const RESERVED = new BlockList();
RESERVED.addSubnet("0.0.0.0", 8, "ipv4");
RESERVED.addSubnet("100.64.0.0", 10, "ipv4");
RESERVED.addSubnet("127.0.0.0", 8, "ipv4");
RESERVED.addSubnet("169.254.0.0", 16, "ipv4");
RESERVED.addSubnet("192.0.0.0", 24, "ipv4");
RESERVED.addSubnet("192.88.99.0", 24, "ipv4");
RESERVED.addSubnet("198.18.0.0", 15, "ipv4");
RESERVED.addSubnet("224.0.0.0", 4, "ipv4");
RESERVED.addSubnet("240.0.0.0", 4, "ipv4");
RESERVED.addAddress("::", "ipv6");
RESERVED.addAddress("::1", "ipv6");
RESERVED.addSubnet("64:ff9b::", 96, "ipv6");
RESERVED.addSubnet("64:ff9b:1::", 48, "ipv6");
RESERVED.addSubnet("2001:0::", 32, "ipv6");
RESERVED.addSubnet("2002::", 16, "ipv6");
RESERVED.addSubnet("fe80::", 10, "ipv6");
RESERVED.addSubnet("fec0::", 10, "ipv6");
RESERVED.addSubnet("ff00::", 8, "ipv6");

/** A private network: reachable only where an administrator has said so. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");

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

function listed(list: BlockList, address: string, family: number): boolean {
  if (family === 6) {
    // Node's BlockList would match an IPv4-mapped rule against every IPv4
    // address, so mapped addresses are unwrapped and checked as IPv4.
    const inner = mappedIpv4(address);
    if (inner) return list.check(inner, "ipv4");
  }
  return list.check(address, family === 6 ? "ipv6" : "ipv4");
}

export function isReservedAddress(address: string, family: number): boolean {
  return listed(RESERVED, address, family);
}

export function isPrivateAddress(address: string, family: number): boolean {
  return listed(PRIVATE, address, family);
}
