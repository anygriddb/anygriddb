import { createPrivateKey, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { healthAuthorities, probeHealth, publicHost } from "./health-probe.js";
import { issueAuthority, issueServer } from "./tls/certificate.js";

/** An authority for `names`, and a server certificate it signs for them. */
function certificates(names: readonly string[]) {
  const authority = issueAuthority({ commonName: "AnyGridDB test", names });
  const cert = new X509Certificate(authority.cert);
  const server = issueServer({
    names,
    authority: {
      cert: authority.cert,
      key: createPrivateKey(authority.key),
      publicKey: cert.publicKey,
      commonName: "AnyGridDB test",
    },
  });
  return { authority: authority.cert, server };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** An API stand-in on the loopback, answering /health with `status`. */
async function serve(
  server: { key: string; cert: string },
  authority: string,
  status = 200,
): Promise<number> {
  const listener = createServer(
    { key: server.key, cert: server.cert + authority },
    (_request, response) => {
      response.statusCode = status;
      response.end('{"ok":true}');
    },
  );
  servers.push(listener);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return (listener.address() as AddressInfo).port;
}

describe("probeHealth", () => {
  it("answers 0 over a certificate valid for the public name", async () => {
    // The instance's own certificate: the public name and the loopback.
    const own = certificates(["grid.lan", "localhost", "127.0.0.1"]);
    const port = await serve(own.server, own.authority);
    expect(
      await probeHealth({ port, host: "grid.lan", ca: [own.authority] }),
    ).toBe(0);
    // An operator's certificate may name the public host only.
    const operator = certificates(["grid.example.org"]);
    const other = await serve(operator.server, operator.authority);
    expect(
      await probeHealth({
        port: other,
        host: "grid.example.org",
        ca: [operator.authority],
      }),
    ).toBe(0);
  });

  it("answers 1 for an unknown authority, another name, or a failing API", async () => {
    const own = certificates(["grid.lan", "127.0.0.1"]);
    const port = await serve(own.server, own.authority);
    const stranger = certificates(["grid.lan"]).authority;
    expect(await probeHealth({ port, host: "grid.lan", ca: [stranger] })).toBe(
      1,
    );
    expect(
      await probeHealth({ port, host: "other.example", ca: [own.authority] }),
    ).toBe(1);
    const down = await serve(own.server, own.authority, 503);
    expect(
      await probeHealth({ port: down, host: "grid.lan", ca: [own.authority] }),
    ).toBe(1);
  });
});

describe("health settings", () => {
  it("reads the public host and the authorities that exist", async () => {
    expect(publicHost({ PUBLIC_URL: "https://grid.lan:3000" }, 4000)).toBe(
      "grid.lan",
    );
    expect(publicHost({ PUBLIC_URL: "https://[::1]:3000" }, 4000)).toBe("::1");
    expect(publicHost({}, 4000)).toBe("localhost");
    const dir = await mkdtemp(join(tmpdir(), "ag-health-"));
    try {
      const own = certificates(["localhost"]);
      await writeFile(join(dir, "authority.crt"), own.authority);
      const found = await healthAuthorities({
        TLS_DIR: dir,
        TLS_CERT_FILE: join(dir, "missing.pem"),
      });
      expect(found).toContain(own.authority);
      expect(found.length).toBeGreaterThan(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
