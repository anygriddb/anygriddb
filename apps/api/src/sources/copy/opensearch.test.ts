/**
 * The OpenSearch connector against a server this process owns: what it
 * accepts, what it refuses, and that a redirect is not followed.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import type { SourceConnection } from "../types.js";
import { issueAuthority, issueServer } from "../../tls/certificate.js";
import { opensearch, patternPath } from "./opensearch.js";

function connection(
  port: number,
  password = "reader-secret",
  queryTimeoutMs = 2_000,
): SourceConnection {
  return {
    engine: "opensearch",
    host: "127.0.0.1",
    port,
    database: "",
    username: "reader",
    password,
    tlsCa: null,
    queryTimeoutMs,
  };
}

function listen(
  onRequest: http.RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(onRequest);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
    server.on("error", reject);
  });
}

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("opensearch check", () => {
  it("accepts a reader on a cluster that says it is OpenSearch", async () => {
    const server = await listen((request, response) => {
      if (request.url === "/") {
        json(response, 200, {
          version: { distribution: "opensearch", number: "2.19.7" },
        });
        return;
      }
      if (request.url === "/_plugins/_security/authinfo") {
        json(response, 200, { roles: ["readall"] });
        return;
      }
      json(response, 404, {});
    });
    try {
      const found = await opensearch.check(connection(server.port), {
        allowPlaintext: true,
      });
      expect(found.serverVersion).toBe("OpenSearch 2.19.7");
    } finally {
      await server.close();
    }
  });

  it("refuses a cluster that is not OpenSearch, and an account that administers one", async () => {
    const other = await listen((_request, response) => {
      json(response, 200, {
        version: { distribution: "other", number: "8.0.0" },
      });
    });
    const admin = await listen((request, response) => {
      if (request.url === "/") {
        json(response, 200, {
          version: { distribution: "opensearch", number: "2.19.7" },
        });
        return;
      }
      json(response, 200, { roles: ["all_access"] });
    });
    try {
      await expect(
        opensearch.check(connection(other.port), { allowPlaintext: true }),
      ).rejects.toMatchObject({ code: "source_engine_mismatch" });
      await expect(
        opensearch.check(connection(admin.port), { allowPlaintext: true }),
      ).rejects.toMatchObject({ code: "source_admin_account" });
    } finally {
      await other.close();
      await admin.close();
    }
  });

  it("names the permission an account that signs in is refused", async () => {
    // Signed in, and refused the cluster's own description.
    const server = await listen((_request, response) => {
      json(response, 403, { error: { type: "security_exception" } });
    });
    try {
      await expect(
        opensearch.check(connection(server.port), { allowPlaintext: true }),
      ).rejects.toMatchObject({
        code: "source_permission_missing",
        detail: "cluster:monitor/main",
      });
    } finally {
      await server.close();
    }
  });

  it("does not follow a redirect to another host", async () => {
    let followed = 0;
    const elsewhere = await listen((_request, response) => {
      followed += 1;
      json(response, 200, {
        version: { distribution: "opensearch", number: "2.19.7" },
      });
    });
    const front = await listen((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${elsewhere.port}/stolen`,
      });
      response.end();
    });
    try {
      await expect(
        opensearch.check(connection(front.port), { allowPlaintext: true }),
      ).rejects.toBeInstanceOf(AppError);
      expect(followed).toBe(0);
    } finally {
      await front.close();
      await elsewhere.close();
    }
  });

  it("stops an answer that comes a byte at a time past the source's limit", async () => {
    const sockets = new Set<Socket>();
    const slow = await listen((request, response) => {
      sockets.add(request.socket);
      response.writeHead(200, { "content-type": "application/json" });
      // A byte every 100 ms keeps the socket's own limit from firing.
      const drip = setInterval(() => response.write(" "), 100);
      response.on("close", () => clearInterval(drip));
    });
    try {
      const started = Date.now();
      await expect(
        opensearch.check(connection(slow.port, "reader-secret", 500), {
          allowPlaintext: true,
        }),
      ).rejects.toMatchObject({ code: "source_timeout" });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await slow.close();
    }
  });

  it("trusts the source's authority and refuses a different one", async () => {
    const authority = issueAuthority({
      commonName: "Test authority",
      names: ["127.0.0.1"],
    });
    const issued = issueServer({
      names: ["127.0.0.1"],
      authority: {
        cert: authority.cert,
        key: createPrivateKey(authority.key),
        publicKey: new X509Certificate(authority.cert).publicKey,
        commonName: "Test authority",
      },
    });
    const server = https.createServer(
      { key: issued.key, cert: issued.cert },
      (request, response) => {
        if (request.url === "/") {
          json(response, 200, {
            version: { distribution: "opensearch", number: "2.19.7" },
          });
          return;
        }
        json(response, 200, { roles: ["readall"] });
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const base = connection(port);
    try {
      const found = await opensearch.check(
        { ...base, tlsCa: authority.cert },
        { allowPlaintext: false },
      );
      expect(found.serverVersion).toBe("OpenSearch 2.19.7");
      const other = issueAuthority({
        commonName: "Other authority",
        names: ["127.0.0.1"],
      });
      await expect(
        opensearch.check(
          { ...base, tlsCa: other.cert },
          { allowPlaintext: false },
        ),
      ).rejects.toBeInstanceOf(AppError);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("the indices a source names", () => {
  it("reads every index the account may read when it names none", () => {
    expect(patternPath({ database: "" })).toBe("*");
    expect(patternPath({ database: " , " })).toBe("*");
  });

  it("keeps each pattern it names, encoded", () => {
    expect(patternPath({ database: "orders-*, logs" })).toBe("orders-*,logs");
    expect(patternPath({ database: "a/b" })).toBe("a%2Fb");
  });
});
