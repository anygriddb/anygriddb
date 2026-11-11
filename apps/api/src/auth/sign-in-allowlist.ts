/**
 * Optional CIDR allowlist for interactive sign-in (password, SSO, passkey).
 * Empty means any client address. Uses the request IP after trusted proxies.
 */
import { BlockList, isIP } from "node:net";
import { AppError } from "@anygriddb/core";

/** One IPv4/IPv6 address or CIDR range. */
export function parseSignInCidr(entry: string): {
  address: string;
  bits?: number;
  family: 4 | 6;
} {
  const trimmed = entry.trim();
  const [address = "", prefix, ...rest] = trimmed.split("/");
  if (rest.length > 0) throw new AppError("invalid_input", "signInAllowlist");
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new AppError("invalid_input", "signInAllowlist");
  }
  if (prefix === undefined) {
    return { address, family };
  }
  const bits = Number(prefix);
  const max = family === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) {
    throw new AppError("invalid_input", "signInAllowlist");
  }
  return { address, bits, family };
}

export class SignInAllowList {
  private readonly list = new BlockList();
  readonly empty: boolean;

  constructor(entries: readonly string[]) {
    this.empty = entries.length === 0;
    for (const entry of entries) {
      const parsed = parseSignInCidr(entry);
      const type = parsed.family === 6 ? "ipv6" : "ipv4";
      if (parsed.bits === undefined) {
        this.list.addAddress(parsed.address, type);
      } else {
        this.list.addSubnet(parsed.address, parsed.bits, type);
      }
    }
  }

  allows(ip: string | undefined | null): boolean {
    if (this.empty) return true;
    if (!ip) return false;
    const host = ip.replace(/^\[|\]$/g, "");
    const family = isIP(host);
    if (family === 0) return false;
    return this.list.check(host, family === 6 ? "ipv6" : "ipv4");
  }
}

/** Refuses interactive sign-in from an address outside the allowlist. */
export function assertSignInAddressAllowed(
  entries: readonly string[],
  ip: string | undefined | null,
): void {
  if (!new SignInAllowList(entries).allows(ip)) {
    throw new AppError("sign_in_address_denied");
  }
}
