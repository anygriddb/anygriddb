import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import type { Database } from "@anygriddb/db";
import { afterEach, describe, expect, it } from "vitest";
import { readSyslogCollector } from "../env.js";
import { issueAuthority, issueServer } from "../tls/certificate.js";
import { collectorPayload, type CollectorPayload } from "./siem.js";
import {
  assertCollectorAllowed,
  deliverSyslogEvent,
  formatSyslogLine,
  sendSyslogLine,
  sendSyslogTest,
  syslogUpdateSchema,
} from "./syslog.js";

const PAYLOAD: CollectorPayload = {
  action: "login_failure",
  userId: "00000000-0000-4000-8000-000000000001",
  actorId: null,
  method: "password",
  detail: "invalid_credentials",
  ip: "192.0.2.10",
  occurredAt: "2026-11-14T15:00:00.000Z",
};

/** An authority and a server certificate for `localhost`, made for a test. */
function certificates(commonName: string) {
  const authority = issueAuthority({ commonName, names: ["localhost"] });
  const leaf = issueServer({
    names: ["localhost"],
    authority: {
      cert: authority.cert,
      key: createPrivateKey(authority.key),
      publicKey: new X509Certificate(authority.cert).publicKey,
      commonName,
    },
  });
  return { authority, leaf };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A TLS collector on a port of its own: what it received, once closed. */
async function collector(leaf: { key: string; cert: string }) {
  const received: string[] = [];
  const server = createServer({ key: leaf.key, cert: leaf.cert }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      socket.end();
    });
    socket.on("error", () => undefined);
  });
  // A client that refuses the certificate ends the handshake.
  server.on("tlsClientError", () => undefined);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, received };
}

describe("the collector named in the environment", () => {
  it("is none without a host, and takes RFC 5425's port by default", () => {
    expect(readSyslogCollector({})).toBeUndefined();
    expect(readSyslogCollector({ SYSLOG_HOST: " " })).toBeUndefined();
    expect(readSyslogCollector({ SYSLOG_HOST: "Logs.Example.org" })).toEqual({
      host: "logs.example.org",
      port: 6514,
    });
    expect(
      readSyslogCollector({ SYSLOG_HOST: "[2001:db8::7]", SYSLOG_PORT: "601" }),
    ).toEqual({ host: "2001:db8::7", port: 601 });
  });

  it("reads the operator's authority from its file", async () => {
    const folder = await mkdtemp(join(tmpdir(), "anygriddb-syslog-"));
    const file = join(folder, "ca.pem");
    const { authority } = certificates("AnyGridDB syslog test");
    await writeFile(file, authority.cert);
    expect(
      readSyslogCollector({
        SYSLOG_HOST: "logs.example.org",
        SYSLOG_CA_FILE: file,
      }),
    ).toEqual({ host: "logs.example.org", port: 6514, ca: authority.cert });

    await writeFile(file, "not a certificate");
    expect(() =>
      readSyslogCollector({
        SYSLOG_HOST: "logs.example.org",
        SYSLOG_CA_FILE: file,
      }),
    ).toThrow("SYSLOG_CA_FILE must hold a PEM certificate");
    // The variable's name, never the path.
    const missing = join(folder, "missing.pem");
    expect(() =>
      readSyslogCollector({
        SYSLOG_HOST: "logs.example.org",
        SYSLOG_CA_FILE: missing,
      }),
    ).toThrow(/^SYSLOG_CA_FILE could not be read \(ENOENT\)$/);
  });

  it("refuses what names no collector", () => {
    for (const source of [
      { SYSLOG_HOST: "logs.example.org/path" },
      { SYSLOG_HOST: "user@logs.example.org" },
      { SYSLOG_HOST: "tcp://logs.example.org" },
      { SYSLOG_HOST: "logs.example.org", SYSLOG_PORT: "0" },
      { SYSLOG_HOST: "logs.example.org", SYSLOG_PORT: "70000" },
      { SYSLOG_HOST: "logs.example.org", SYSLOG_PORT: "tls" },
      { SYSLOG_PORT: "6514" },
      { SYSLOG_CA_FILE: "/run/secrets/ca.pem" },
    ]) {
      expect(() => readSyslogCollector(source)).toThrow(/^SYSLOG_/);
    }
  });
});

describe("a syslog line", () => {
  it("is one RFC 5424 line: its header, then the event as JSON", () => {
    const line = formatSyslogLine(PAYLOAD, "grid-1");
    expect(line).toBe(
      `<133>1 2026-11-14T15:00:00.000Z grid-1 anygriddb - auth - ${JSON.stringify(
        { source: "anygriddb", ...PAYLOAD },
      )}`,
    );
    // Ids and codes: no address of a person.
    expect(line).not.toContain("@");
    expect(line.includes("\n")).toBe(false);
  });

  it("keeps a host name that holds a space from breaking the header", () => {
    const line = formatSyslogLine(PAYLOAD, "my host\n");
    expect(line.startsWith("<133>1 2026-11-14T15:00:00.000Z my_host_ ")).toBe(
      true,
    );
    expect(formatSyslogLine(PAYLOAD, "").split(" ")[2]).toBe("-");
  });

  it("is sent for the events a collector gets, and no other", () => {
    expect(collectorPayload({ action: "login_failure" })).toMatchObject({
      action: "login_failure",
      userId: null,
    });
    expect(collectorPayload({ action: "login_success" })).toBeNull();
    expect(collectorPayload({ action: "logout" })).toBeNull();
  });
});

describe("sending to the collector", () => {
  it("writes one frame counted in octets, over a certificate it verified", async () => {
    const { authority, leaf } = certificates("AnyGridDB syslog test");
    const { port, received } = await collector(leaf);
    const line = formatSyslogLine({ ...PAYLOAD, detail: "détail" }, "grid-1");
    await sendSyslogLine({ host: "localhost", port, ca: authority.cert }, line);
    await expect
      .poll(() => received)
      .toEqual([`${String(Buffer.byteLength(line))} ${line}`]);
    // Octets, not characters.
    expect(Buffer.byteLength(line)).toBeGreaterThan(line.length);
  });

  it("sends nothing to a collector whose certificate it cannot verify", async () => {
    const { leaf } = certificates("AnyGridDB syslog test");
    const { port, received } = await collector(leaf);
    // No authority of the operator's: the system's do not know this one.
    await expect(
      sendSyslogLine({ host: "localhost", port }, "line"),
    ).rejects.toThrow();
    // Another authority than the one that signed it.
    const other = certificates("Another authority");
    await expect(
      sendSyslogLine(
        { host: "localhost", port, ca: other.authority.cert },
        "line",
      ),
    ).rejects.toThrow();
    // The right authority, a name the certificate does not hold.
    const { authority } = certificates("AnyGridDB syslog test");
    await expect(
      sendSyslogLine({ host: "127.0.0.1", port, ca: authority.cert }, "line"),
    ).rejects.toThrow();
    expect(received).toEqual([]);
  });

  it("gives up on a collector that does not answer, within its limit", async () => {
    // Accepts the connection and never speaks TLS.
    const { createServer: createPlain } = await import("node:net");
    const silent = createPlain(() => undefined);
    await new Promise<void>((resolve) =>
      silent.listen(0, "127.0.0.1", resolve),
    );
    const { port } = silent.address() as AddressInfo;
    try {
      const started = Date.now();
      await expect(
        sendSyslogLine({ host: "localhost", port }, "line", 300),
      ).rejects.toThrow("syslog collector timed out");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      silent.close();
    }
  });

  it("throws for the queue to try again when the environment's collector is away", async () => {
    // The environment names the collector: the database is not asked.
    const unasked = null as unknown as Database;
    const { createServer: createPlain } = await import("node:net");
    const closed = createPlain();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(
      deliverSyslogEvent(unasked, { host: "127.0.0.1", port }, PAYLOAD),
    ).rejects.toMatchObject({ code: "invalid_delivery", detail: "syslog" });
    // The test from Administration, on a collector that is away.
    await expect(
      sendSyslogTest(
        unasked,
        { host: "127.0.0.1", port },
        "00000000-0000-4000-8000-000000000002",
      ),
    ).rejects.toMatchObject({ code: "syslog_unreachable" });
  });
});

describe("a collector named in Administration", () => {
  const publicAddress = () =>
    Promise.resolve([{ address: "203.0.113.10", family: 4 }]);
  const privateAddress = () =>
    Promise.resolve([{ address: "10.1.2.3", family: 4 }]);

  it("takes a host, a port, and an authority, and gives the port its default", () => {
    expect(syslogUpdateSchema.parse({ host: " Logs.Example.ORG " })).toEqual({
      host: "logs.example.org",
      port: 6514,
    });
    expect(
      syslogUpdateSchema.safeParse({
        host: "logs.example.org",
        port: 6515,
        ca: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      }).success,
    ).toBe(true);
  });

  it("refuses what names no collector", () => {
    for (const input of [
      { host: "" },
      { host: "logs example" },
      { host: "https://logs.example.org" },
      { host: "logs.example.org", port: 0 },
      { host: "logs.example.org", port: 70_000 },
      { host: "logs.example.org", ca: "not a certificate" },
      { host: "logs.example.org", secret: "x" },
    ]) {
      expect(syslogUpdateSchema.safeParse(input).success, input.host).toBe(
        false,
      );
    }
  });

  it("is allowed on a public address, and on a private one only where those are", async () => {
    const collector = { host: "logs.example.org", port: 6514 };
    await expect(
      assertCollectorAllowed(collector, false, publicAddress),
    ).resolves.toBeUndefined();
    await expect(
      assertCollectorAllowed(collector, false, privateAddress),
    ).rejects.toMatchObject({ code: "invalid_syslog_target" });
    await expect(
      assertCollectorAllowed(collector, true, privateAddress),
    ).resolves.toBeUndefined();
  });

  it("is never the machine itself, nor a cloud's metadata", async () => {
    for (const host of ["127.0.0.1", "::1", "169.254.169.254", "localhost"]) {
      await expect(
        assertCollectorAllowed({ host, port: 6514 }, true),
        host,
      ).rejects.toMatchObject({ code: "invalid_syslog_target" });
    }
  });
});
