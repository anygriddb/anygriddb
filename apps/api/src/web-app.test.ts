import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync } from "node:zlib";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyApiSecurityHeaders } from "./http.js";
import {
  DOCUMENT_POLICY,
  documentPolicy,
  registerWebApp,
  type ShareEmbedLookup,
} from "./web-app.js";

const PAGE = `<!doctype html>
<html lang="fr">
  <head>
    <title>AnyGridDB</title>
  </head>
  <body><div id="root"></div></body>
</html>
`;

const SHARE_TOKEN = "a".repeat(32);

async function build(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anygriddb-web-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), PAGE);
  await writeFile(join(root, "assets", "index-abc123.js"), "export {};");
  await writeFile(join(root, "theme.js"), "void 0;");
  return root;
}

async function server(
  root: string,
  shareEmbedOrigins?: ShareEmbedLookup,
  tileOrigin?: () => Promise<string | null>,
) {
  const app = Fastify();
  // As the server does for every request, before any route answers.
  app.addHook("onRequest", async (_request, reply) => {
    applyApiSecurityHeaders(reply, false);
  });
  app.get("/api/v1/bases", () => ({ bases: [] }));
  await registerWebApp(app, root, { shareEmbedOrigins, tileOrigin });
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

  it("softens frame-ancestors only for a share that opted into embed", async () => {
    const origins = ["https://portal.example.com", "https://wiki.example.org"];
    const app = await server(await build(), async (token) =>
      token === SHARE_TOKEN ? origins : null,
    );
    const embeddable = await app.inject({ url: `/s/${SHARE_TOKEN}` });
    expect(embeddable.statusCode).toBe(200);
    expect(embeddable.headers["content-security-policy"]).toBe(
      documentPolicy({ embedOrigins: origins }),
    );
    expect(embeddable.headers["content-security-policy"]).toContain(
      "frame-ancestors https://portal.example.com https://wiki.example.org",
    );
    expect(embeddable.headers["content-security-policy"]).not.toContain(
      "frame-ancestors 'none'",
    );
    expect(embeddable.headers["x-frame-options"]).toBeUndefined();

    const plain = await app.inject({ url: `/s/${"b".repeat(32)}` });
    expect(plain.headers["content-security-policy"]).toBe(DOCUMENT_POLICY);
    expect(plain.headers["x-frame-options"]).toBe("DENY");
    expect(plain.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );

    const home = await app.inject({ url: "/" });
    expect(home.headers["content-security-policy"]).toBe(DOCUMENT_POLICY);
  });

  it("lets images come from the tile server an administrator named, and no other", async () => {
    let origin: string | null = "https://tiles.example.org";
    const app = await server(
      await build(),
      async () => ["https://portal.example.org"],
      async () => origin,
    );
    const page = await app.inject({ url: "/b/1/t/2" });
    expect(page.headers["content-security-policy"]).toContain(
      "img-src 'self' blob: data: https://tiles.example.org;",
    );
    expect(page.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    // A shared map embedded in a site has both.
    const shared = await app.inject({ url: `/s/${SHARE_TOKEN}` });
    expect(shared.headers["content-security-policy"]).toBe(
      documentPolicy({
        embedOrigins: ["https://portal.example.org"],
        tileOrigin: "https://tiles.example.org",
      }),
    );
    // No server named: images come from the app alone, as before.
    origin = null;
    expect(
      (await app.inject({ url: "/b/1/t/2" })).headers[
        "content-security-policy"
      ],
    ).toBe(DOCUMENT_POLICY);
    expect(DOCUMENT_POLICY).toContain("img-src 'self' blob: data:;");
  });

  it("keeps frame-ancestors none when the embed lookup fails", async () => {
    const app = await server(await build(), async () => {
      throw new Error("db down");
    });
    const response = await app.inject({ url: `/s/${SHARE_TOKEN}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBe(DOCUMENT_POLICY);
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
