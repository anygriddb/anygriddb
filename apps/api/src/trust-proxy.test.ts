import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { trustProxy } from "./trust-proxy.js";

/** The client address the API keeps for a request from `peer`. */
async function clientAddress(
  proxies: readonly string[],
  peer: string,
  forwarded: string,
): Promise<string> {
  const app = Fastify({ trustProxy: trustProxy(proxies) });
  app.get("/", (request) => request.ip);
  const response = await app.inject({
    method: "GET",
    url: "/",
    remoteAddress: peer,
    headers: { "x-forwarded-for": forwarded },
  });
  await app.close();
  return response.body;
}

describe("trustProxy", () => {
  it("ignores a forwarded address when no proxy is configured", async () => {
    expect(trustProxy([])).toBe(false);
    expect(await clientAddress([], "198.51.100.7", "203.0.113.5")).toBe(
      "198.51.100.7",
    );
  });

  it("takes the address a named proxy forwards, by address or by range", async () => {
    expect(await clientAddress(["127.0.0.1"], "127.0.0.1", "203.0.113.5")).toBe(
      "203.0.113.5",
    );
    expect(
      await clientAddress(["172.18.0.0/16"], "172.18.0.4", "203.0.113.5"),
    ).toBe("203.0.113.5");
    // A dual-stack listener names an IPv4 peer in IPv6 form.
    expect(
      await clientAddress(["127.0.0.1"], "::ffff:127.0.0.1", "203.0.113.5"),
    ).toBe("203.0.113.5");
  });

  it("does not believe a peer the operator did not name", async () => {
    expect(
      await clientAddress(["127.0.0.1"], "198.51.100.7", "203.0.113.5"),
    ).toBe("198.51.100.7");
    // What the client wrote before the proxy added the real address.
    expect(
      await clientAddress(
        ["127.0.0.1"],
        "127.0.0.1",
        "192.0.2.99, 203.0.113.5",
      ),
    ).toBe("203.0.113.5");
  });
});
