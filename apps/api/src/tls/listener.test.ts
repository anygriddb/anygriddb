import { createPrivateKey, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { get as httpGet } from "node:http";
import { createServer, get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueAuthority, issueServer } from "./certificate.js";
import { plainResponse, redirectPlainHttp } from "./listener.js";

describe("plainResponse", () => {
  it("redirects to the same host and path over HTTPS", () => {
    expect(
      plainResponse("GET /bases/1?view=2 HTTP/1.1\r\nHost: grid.lan:3000"),
    ).toContain("Location: https://grid.lan:3000/bases/1?view=2\r\n");
    expect(plainResponse("GET / HTTP/1.1\r\nhost: [::1]:3000")).toContain(
      "Location: https://[::1]:3000/\r\n",
    );
  });

  it("refuses a request that names no valid host or target", () => {
    for (const head of [
      "GET / HTTP/1.1",
      "GET / HTTP/1.1\r\nHost: evil.example/x",
      "GET / HTTP/1.1\r\nHost: a b",
      "GET http://other/ HTTP/1.1\r\nHost: grid.lan",
    ]) {
      expect(plainResponse(head), head).toMatch(/^HTTP\/1\.1 400 /);
    }
  });
});

describe("one port, HTTPS only", () => {
  const authority = issueAuthority({
    commonName: "AnyGridDB test",
    names: ["localhost", "127.0.0.1"],
  });
  const ca = new X509Certificate(authority.cert);
  const issued = issueServer({
    names: ["localhost", "127.0.0.1"],
    authority: {
      cert: authority.cert,
      key: createPrivateKey(authority.key),
      publicKey: ca.publicKey,
      commonName: "AnyGridDB test",
    },
  });
  const server = createServer(
    { key: issued.key, cert: issued.cert + authority.cert },
    (_request, response) => {
      response.end("secure");
    },
  );
  let port = 0;

  beforeAll(async () => {
    redirectPlainHttp(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it("answers plain HTTP with a redirect and nothing else", async () => {
    const response = await new Promise<{
      status?: number;
      location?: string;
      body: string;
    }>((resolve, reject) => {
      httpGet(`http://127.0.0.1:${String(port)}/login?next=%2F`, (answer) => {
        let body = "";
        answer.on("data", (chunk: Buffer) => (body += chunk.toString()));
        answer.on("end", () => {
          resolve({
            status: answer.statusCode,
            location: answer.headers.location,
            body,
          });
        });
      }).on("error", reject);
    });
    expect(response).toEqual({
      status: 308,
      location: `https://127.0.0.1:${String(port)}/login?next=%2F`,
      body: "",
    });
  });

  it("serves HTTPS on the same port, trusted through the authority", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      httpsGet(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          ca: authority.cert,
          servername: "localhost",
        },
        (answer) => {
          let text = "";
          answer.on("data", (chunk: Buffer) => (text += chunk.toString()));
          answer.on("end", () => resolve(text));
        },
      ).on("error", reject);
    });
    expect(body).toBe("secure");
  });
});
