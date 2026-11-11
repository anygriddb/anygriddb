import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCompression } from "./compression.js";

const ROWS = {
  rows: Array.from({ length: 200 }, (_, index) => ({
    id: `row-${String(index)}`,
    title: "The same words, row after row",
  })),
};

async function server() {
  const app = Fastify();
  await registerCompression(app);
  app.get("/rows", () => ROWS);
  app.get("/small", () => ({ ok: true }));
  // What tRPC hands to Fastify: a fetch Response.
  app.get("/batch", (_request, reply) =>
    reply.send(
      new Response(JSON.stringify(ROWS), {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  app.get("/picture", (_request, reply) =>
    reply.type("image/png").send(Buffer.alloc(4096, 7)),
  );
  app.post("/echo", (request) => ({ got: request.body }));
  await app.ready();
  return app;
}

describe("compressed answers", () => {
  it("compresses JSON with what the browser accepts, Brotli first", async () => {
    const app = await server();
    const plain = JSON.stringify(ROWS);
    const brotli = await app.inject({
      url: "/rows",
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers.vary).toContain("accept-encoding");
    expect(brotliDecompressSync(brotli.rawPayload).toString()).toBe(plain);
    expect(brotli.rawPayload.length).toBeLessThan(plain.length / 5);
    const gzip = await app.inject({
      url: "/batch",
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gzip.rawPayload).toString()).toBe(plain);
  });

  it("leaves small answers, pictures, and browsers that ask for nothing alone", async () => {
    const app = await server();
    const headers = { "accept-encoding": "br, gzip" };
    const small = await app.inject({ url: "/small", headers });
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(small.json()).toEqual({ ok: true });
    const picture = await app.inject({ url: "/picture", headers });
    expect(picture.headers["content-encoding"]).toBeUndefined();
    expect(picture.rawPayload).toHaveLength(4096);
    const unasked = await app.inject({ url: "/rows" });
    expect(unasked.headers["content-encoding"]).toBeUndefined();
    expect(unasked.json()).toEqual(ROWS);
  });

  it("does not unpack a compressed request body", async () => {
    const app = await server();
    const response = await app.inject({
      method: "POST",
      url: "/echo",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      payload: gzipSync(JSON.stringify({ secret: "x".repeat(10_000) })),
    });
    expect(response.statusCode).toBe(400);
  });
});
