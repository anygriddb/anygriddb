import { BlockList, isIP } from "node:net";

/**
 * The hosts on which an administrator may declare a source (ADR 0006), set
 * by the operator in ANYGRIDDB_SOURCES_ALLOWED_HOSTS: host names, `*.`
 * domains, IP addresses, and CIDR ranges, comma-separated. Empty allows
 * none: sources sit on the internal network, which nothing else may reach.
 */
export class HostAllowList {
  private readonly names = new Set<string>();
  private readonly domains: string[] = [];
  private readonly addresses = new BlockList();
  readonly entries: readonly string[];

  constructor(spec: string | undefined) {
    const entries = (spec ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== "");
    for (const entry of entries) {
      const [address = "", prefix] = entry.split("/");
      const family = isIP(address);
      if (family !== 0) {
        const type = family === 6 ? "ipv6" : "ipv4";
        if (prefix === undefined) {
          this.addresses.addAddress(address, type);
        } else {
          const bits = Number(prefix);
          if (
            !Number.isInteger(bits) ||
            bits < 0 ||
            bits > (family === 6 ? 128 : 32)
          ) {
            throw new Error(
              `ANYGRIDDB_SOURCES_ALLOWED_HOSTS: invalid range ${entry}`,
            );
          }
          this.addresses.addSubnet(address, bits, type);
        }
      } else if (entry.startsWith("*.") && entry.length > 2) {
        this.domains.push(entry.slice(1));
      } else if (/^[a-z0-9.-]+$/.test(entry) && !entry.includes("*")) {
        this.names.add(entry);
      } else {
        throw new Error(
          `ANYGRIDDB_SOURCES_ALLOWED_HOSTS: invalid entry ${entry}`,
        );
      }
    }
    this.entries = entries;
  }

  allows(host: string): boolean {
    const name = host.toLowerCase();
    const family = isIP(name);
    if (family !== 0) {
      return this.addresses.check(name, family === 6 ? "ipv6" : "ipv4");
    }
    return (
      this.names.has(name) ||
      this.domains.some((domain) => name.endsWith(domain))
    );
  }
}
