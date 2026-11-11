import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync } from "node:zlib";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { DOCUMENT_POLICY, registerWebApp } from "./web-app.js";

const PAGE = `<!doctype html>
<html lang="fr">
  <head>
    <title>AnyGridDB</title>
  </head>
  <body><div id="root"></div></body>
</html>
`;

async function build(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anygriddb-web-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), PAGE);
  await writeFile(join(root, "assets", "index-abc123.js"), "export {};");
  await writeFile(join(root, "theme.js"), "void 0;");
  return root;
}

async function server(root: string) {
  const app = Fastify();
  app.get("/api/v1/bases", () => ({ bases: [] }));
  await registerWebApp(app, root);
  await app.ready();
  return app;
}

describe("the web app", () => {
  it("serves the page with its policy on every app path", async () => {
    const app = await server(await build());
    for (const url of ["/", "/b/1/t/2", "/settings?welcome=true", "/login"]) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["content-security-policy"]).toBe(DOCUMENT_POLICY);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.body).toBe(PAGE);
    }
  });

  it("asks search engines to skip the pages of a secret link", async () => {
    const app = await server(await build());
    for (const url of ["/s/abc", "/invite/xyz", "/reset/abc", "/signup/xyz"]) {
      const response = await app.inject({ url });
      expect(response.body).toContain(
        '<meta name="robots" content="noindex, nofollow" />',
      );
    }
    expect((await app.inject({ url: "/" })).body).not.toContain("noindex");
  });

  it("caches hashed files for a year and the rest not at all", async () => {
    const app = await server(await build());
    const asset = await app.inject({ url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    const theme = await app.inject({ url: "/theme.js" });
    expect(theme.headers["cache-control"]).toBe("no-cache");
  });

  it("sends the compressed copy of a built file to a browser that accepts it", async () => {
    const root = await build();
    const script = `export const words = ${JSON.stringify("grid ".repeat(400))};`;
    const file = join(root, "assets", "grid-def456.js");
    await writeFile(file, script);
    await writeFile(`${file}.br`, brotliCompressSync(script));
    await writeFile(`${file}.gz`, gzipSync(script));
    const app = await server(root);
    const url = "/assets/grid-def456.js";
    const brotli = await app.inject({
      url,
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(brotli.statusCode).toBe(200);
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers["content-type"]).toContain("javascript");
    expect(brotli.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(brotli.headers.vary).toContain("accept-encoding");
    expect(brotliDecompressSync(brotli.rawPayload).toString()).toBe(script);
    const gzip = await app.inject({
      url,
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    // A browser that asks for nothing, and a file without a copy, get the
    // file itself.
    const plain = await app.inject({ url });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body).toBe(script);
    const uncopied = await app.inject({
      url: "/assets/index-abc123.js",
      headers: { "accept-encoding": "br" },
    });
    expect(uncopied.statusCode).toBe(200);
    expect(uncopied.headers["content-encoding"]).toBeUndefined();
    expect(uncopied.body).toBe("export {};");
    // The copies are not files of their own.
    expect((await app.inject({ url: `${url}.br` })).statusCode).toBe(404);
    expect((await app.inject({ url: `${url}.gz` })).statusCode).toBe(404);
  });

  it("answers 404, not the page, for API paths, files, and other methods", async () => {
    const app = await server(await build());
    expect((await app.inject({ url: "/api/v1/bases" })).statusCode).toBe(200);
    for (const request of [
      { url: "/api/v1/unknown" },
      { url: "/trpc/unknown" },
      { url: "/auth/nowhere" },
      { url: "/assets/index-old999.js" },
      { url: "/index.html" },
      { url: "/b/1", method: "POST" as const },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "Not found",
        code: "not_found",
      });
    }
  });

  it("serves the API alone when the app is not built", async () => {
    const app = await server(await mkdtemp(join(tmpdir(), "anygriddb-web-")));
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
  });
});
