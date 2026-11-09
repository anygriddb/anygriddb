import { createPrivateKey, X509Certificate } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { issueAuthority, issueServer, type Issued } from "./certificate.js";

const NAMES = ["localhost", "grid.lan", "127.0.0.1", "::1", "192.168.1.10"];

function authority(names: readonly string[] = NAMES) {
  const issued = issueAuthority({ commonName: "AnyGridDB test", names });
  const cert = new X509Certificate(issued.cert);
  return {
    issued,
    cert,
    signer: {
      cert: issued.cert,
      key: createPrivateKey(issued.key),
      publicKey: cert.publicKey,
      commonName: "AnyGridDB test",
    },
  };
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Whether a client trusting `ca` accepts `server` for `servername`. */
async function handshake(
  server: Issued,
  ca: string,
  servername: string,
): Promise<string | null> {
  const listener = createServer({ key: server.key, cert: server.cert + ca });
  servers.push(listener);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;
  const socket = connect({ host: "127.0.0.1", port, ca, servername });
  const result = await new Promise<string | null>((resolve) => {
    socket.once("secureConnect", () => {
      resolve(socket.authorized ? null : String(socket.authorizationError));
    });
    socket.once("error", (error: Error & { code?: string }) => {
      resolve(`${error.code ?? ""} ${error.message}`);
    });
  });
  socket.destroy();
  return result;
}

describe("AnyGridDB's authority", () => {
  it("issues a constrained authority and a server certificate Node reads", () => {
    const ca = authority();
    expect(ca.cert.ca).toBe(true);
    expect(ca.cert.subject).toContain("CN=AnyGridDB test");
    expect(ca.cert.verify(ca.cert.publicKey)).toBe(true);

    const server = issueServer({ names: NAMES, authority: ca.signer });
    const leaf = new X509Certificate(server.cert);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca.cert)).toBe(true);
    expect(leaf.verify(ca.cert.publicKey)).toBe(true);
    expect(leaf.checkHost("localhost")).toBe("localhost");
    expect(leaf.checkHost("grid.lan")).toBe("grid.lan");
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leaf.checkIP("192.168.1.10")).toBe("192.168.1.10");
    expect(leaf.subjectAltName).toContain("IP Address:0:0:0:0:0:0:0:1");
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    const days = (new Date(leaf.validTo).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(396);
    expect(days).toBeLessThan(398);
  });

  it("is trusted over TLS for its names, and for nothing else", async () => {
    const ca = authority();
    const server = issueServer({ names: NAMES, authority: ca.signer });
    expect(await handshake(server, ca.issued.cert, "localhost")).toBeNull();
    expect(await handshake(server, ca.issued.cert, "grid.lan")).toBeNull();
    expect(await handshake(server, ca.issued.cert, "other.example")).toMatch(
      /ERR_TLS_CERT_ALTNAME_INVALID|Hostname/,
    );
    // Even a certificate it signed for another site is refused: the
    // authority can only vouch for AnyGridDB's names.
    const rogue = issueServer({
      names: ["bank.example"],
      authority: ca.signer,
    });
    expect(await handshake(rogue, ca.issued.cert, "bank.example")).toMatch(
      /PERMITTED|permitted|constraint/i,
    );
  });
});
