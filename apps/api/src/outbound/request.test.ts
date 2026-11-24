import { createPrivateKey, X509Certificate } from "node:crypto";
import { Agent, createServer, type Server } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import { issueAuthority, issueServer } from "../tls/certificate.js";
import { outboundFailureText, redactSecrets, secretStrings } from "./redact.js";
import {
  OUTBOUND_TIMEOUT_MS,
  lookupAddresses,
  outboundLookup,
  requestOutbound,
} from "./request.js";

const HOST = "hooks.example.org";
const PUBLIC = "203.0.113.10";

/** An authority and a leaf for the name the call uses. */
function certificates() {
  const authority = issueAuthority({
    commonName: "AnyGridDB outbound test",
    names: [HOST],
  });
  const leaf = issueServer({
    names: [HOST],
    authority: {
      cert: authority.cert,
      key: createPrivateKey(authority.key),
      publicKey: new X509Certificate(authority.cert).publicKey,
      commonName: "AnyGridDB outbound test",
    },
  });
  return { authority, leaf };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/**
 * A local HTTPS listener the production lookup would never reach: the
 * call claims a public address, and `createConnection` dials this port.
 */
async function localHttps(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<{ port: number; ca: string }> {
  const { authority, leaf } = certificates();
  const server = createServer(
    { key: leaf.key, cert: leaf.cert + authority.cert },
    handler,
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: authority.cert,
  };
}

const publicLookup: LookupFunction = (_hostname, options, callback) => {
  const list = [{ address: PUBLIC, family: 4 }];
  if (typeof options === "object" && options.all) {
    callback(null, list);
    return;
  }
  callback(null, PUBLIC, 4);
};

/**
 * An agent that dials the local listener over TLS. Lookup still claims a
 * public address so the SSRF gate passes; the socket never leaves the
 * machine.
 */
function pinAgent(port: number, ca: string): Agent {
  const agent = new Agent({
    lookup: publicLookup,
    ca,
    maxCachedSessions: 0,
  });
  const dial: typeof agent.createConnection = (_options, callback) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername: HOST,
      ca,
      rejectUnauthorized: true,
    });
    if (callback) {
      socket.once("secureConnect", () => callback(null, socket));
      socket.once("error", (error) => callback(error, socket));
    }
    return socket;
  };
  agent.createConnection = dial;
  return agent;
}

const resolvePublic = async () => [{ address: PUBLIC, family: 4 }];

function callTo(
  port: number,
  ca: string,
  path: string,
  extras: Partial<Parameters<typeof requestOutbound>[0]> = {},
) {
  return requestOutbound({
    url: `https://${HOST}:${String(port)}${path}`,
    method: "GET",
    maxBytes: 1_024,
    resolve: resolvePublic,
    lookup: publicLookup,
    agent: pinAgent(port, ca),
    ca,
    ...extras,
  });
}

describe("outboundLookup blocks what the socket would reach", () => {
  it("refuses a name that resolves to a private address at connect time", async () => {
    const error = await new Promise<unknown>((resolve) => {
      outboundLookup(false)("localhost", { all: true }, (failure) =>
        resolve(failure),
      );
    });
    expect(error).toBeInstanceOf(Error);
    expect(outboundFailureText(error)).toBe("Blocked target");
  });
});

describe("requestOutbound security", () => {
  it("refuses private and reserved targets before connecting", async () => {
    for (const target of [
      "https://10.0.0.1/",
      "https://localhost/",
      "https://[::1]/",
      "https://169.254.169.254/latest/meta-data/",
      "http://example.org/",
      "https://user:pass@example.org/",
      "https://service.internal/",
    ]) {
      await expect(
        requestOutbound({
          url: target,
          method: "GET",
          maxBytes: 1_000,
        }),
        target,
      ).rejects.toMatchObject({ code: "invalid_outbound_target" });
    }
  });

  it("blocks DNS rebinding: public at assert, private at connect", async () => {
    await expect(
      requestOutbound({
        url: `https://${HOST}/hook`,
        method: "POST",
        body: "{}",
        maxBytes: 1_000,
        resolve: resolvePublic,
        lookup: lookupAddresses([{ address: "10.0.0.1", family: 4 }], false),
      }),
    ).rejects.toMatchObject({ code: "EBLOCKED" });
  });

  it("blocks DNS rebinding to IPv6 loopback at connect time", async () => {
    await expect(
      requestOutbound({
        url: `https://${HOST}/hook`,
        method: "GET",
        maxBytes: 1_000,
        resolve: resolvePublic,
        lookup: lookupAddresses([{ address: "::1", family: 6 }], false),
      }),
    ).rejects.toMatchObject({ code: "EBLOCKED" });
  });

  it("does not follow a redirect to another origin", async () => {
    const { port, ca } = await localHttps((_request, response) => {
      response.writeHead(302, {
        Location: "https://attacker.example/steal",
      });
      response.end("moved");
    });
    const answer = await callTo(port, ca, "/start");
    expect(answer.status).toBe(302);
    expect(answer.body).toBe("moved");
  });

  it("follows one redirect on the same origin, then stops", async () => {
    let hits = 0;
    const { port, ca } = await localHttps((request, response) => {
      hits += 1;
      if (request.url === "/start") {
        response.writeHead(302, { Location: "/final" });
        response.end("go");
        return;
      }
      if (request.url === "/final") {
        response.writeHead(302, { Location: "/again" });
        response.end("second");
        return;
      }
      response.writeHead(200);
      response.end("too far");
    });
    const answer = await callTo(port, ca, "/start");
    expect(answer.status).toBe(302);
    expect(answer.body).toBe("second");
    expect(hits).toBe(2);
  });

  it("does not turn a POST into a GET: a 302 answers as the failure it is", async () => {
    let hits = 0;
    const { port, ca } = await localHttps((request, response) => {
      hits += 1;
      if (request.url === "/hook") {
        response.writeHead(302, { Location: "/landing" });
        response.end("moved");
        return;
      }
      response.writeHead(200);
      response.end("a page, not the delivery");
    });
    const answer = await callTo(port, ca, "/hook", {
      method: "POST",
      body: '{"event":"x"}',
    });
    expect(answer.status).toBe(302);
    expect(hits).toBe(1);
  });

  it("follows a 307 on the same origin with the method and the body", async () => {
    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    const { port, ca } = await localHttps((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        seen.push({ method: request.method, url: request.url, body });
        if (request.url === "/hook") {
          response.writeHead(307, { Location: "/hook/v2" });
          response.end();
          return;
        }
        response.writeHead(204);
        response.end();
      });
    });
    const answer = await callTo(port, ca, "/hook", {
      method: "POST",
      body: '{"event":"x"}',
    });
    expect(answer.status).toBe(204);
    expect(seen).toEqual([
      { method: "POST", url: "/hook", body: '{"event":"x"}' },
      { method: "POST", url: "/hook/v2", body: '{"event":"x"}' },
    ]);
  });

  it("refuses a same-origin redirect whose path resolves to a blocked host", async () => {
    // Location is absolute to metadata; same-origin check fails first.
    const { port, ca } = await localHttps((_request, response) => {
      response.writeHead(302, {
        Location: "https://169.254.169.254/latest",
      });
      response.end("no");
    });
    const answer = await callTo(port, ca, "/start");
    expect(answer.status).toBe(302);
  });

  it("refuses an answer larger than maxBytes", async () => {
    const { port, ca } = await localHttps((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(2_000));
    });
    await expect(callTo(port, ca, "/", { maxBytes: 100 })).rejects.toThrow(
      "Answer too large",
    );
  });

  it("cuts a longer answer where asked, and keeps its status", async () => {
    const { port, ca } = await localHttps((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("y".repeat(5_000));
    });
    const answer = await callTo(port, ca, "/", {
      maxBytes: 100,
      tooLarge: "cut",
    });
    expect(answer.status).toBe(500);
    expect(answer.body).toBe("y".repeat(100));
    const bare = await callTo(port, ca, "/", { maxBytes: 0, tooLarge: "cut" });
    expect(bare).toMatchObject({ status: 500, body: "" });
  });

  it("times out a slow answer", async () => {
    const { port, ca } = await localHttps((_request, _response) => {
      // Never ends: the client must cut it.
    });
    const started = Date.now();
    await expect(callTo(port, ca, "/", { timeoutMs: 200 })).rejects.toThrow(
      "Timeout",
    );
    expect(Date.now() - started).toBeLessThan(OUTBOUND_TIMEOUT_MS);
  });

  it("returns a successful answer under the limit", async () => {
    const { port, ca } = await localHttps((_request, response) => {
      response.writeHead(200, { "x-test": "ok" });
      response.end('{"ok":true}');
    });
    const answer = await callTo(port, ca, "/ok", {
      method: "POST",
      body: "{}",
    });
    expect(answer).toMatchObject({
      status: 200,
      body: '{"ok":true}',
      headers: expect.objectContaining({ "x-test": "ok" }),
    });
  });
});

describe("secrets kept out of what is stored", () => {
  it("collects long strings as secrets and redacts them", () => {
    const secrets = secretStrings({
      token: "super-secret-token",
      nested: { key: "abcdefgh" },
      short: "abc",
    });
    expect(secrets).toEqual(
      expect.arrayContaining(["super-secret-token", "abcdefgh"]),
    );
    expect(secrets).not.toContain("abc");
    expect(
      redactSecrets("got super-secret-token back", ["super-secret-token"]),
    ).toBe("got •••• back");
  });

  it("names failures without quoting an address", () => {
    expect(outboundFailureText(new AppError("invalid_outbound_target"))).toBe(
      "Blocked target",
    );
    expect(outboundFailureText(new Error("Timeout"))).toBe("Timeout");
    expect(outboundFailureText(new Error("Answer too large"))).toBe(
      "Answer too large",
    );
    expect(
      outboundFailureText(
        Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      ),
    ).toBe("Connection refused");
    expect(outboundFailureText(new Error("socket hang up at 10.0.0.3"))).toBe(
      "Network error",
    );
  });
});
