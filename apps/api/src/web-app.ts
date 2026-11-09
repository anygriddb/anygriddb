/**
 * The web app, served on the API's own origin (ADR 0011). Built files are
 * served as they are, hashed ones under /assets cached for a year. Every
 * other page path gets index.html with the document's security policy,
 * and the app's router takes it from there.
 */
import { access, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { publicErrorBody } from "./http.js";

/** `apps/web/dist`, from the sources and from the bundle alike. */
export const DEFAULT_WEB_ROOT = fileURLToPath(
  new URL("../../web/dist/", import.meta.url),
);

/** Paths the API answers itself: an unknown one is a 404, never the app. */
const API_PATH = /^\/(?:api|trpc|auth|ws|health)(?:\/|$)/;
/** A missing file, such as a chunk of an older build: a 404, not a page. */
const FILE_PATH = /\/[^/]*\.[A-Za-z0-9]+$/;
/** Pages reached by a secret link: search engines must not keep them. */
const TOKEN_PAGE = /^\/(?:s|invite)\//;

/**
 * Scripts come from this origin only, with no inline code. Styles allow
 * inline attributes: the grid positions rows with `style`, and toasts
 * insert their stylesheet.
 */
export const DOCUMENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const NOINDEX = '<meta name="robots" content="noindex, nofollow" />';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serves the built app from `root`. Without a build there (the API run on
 * its own, next to the Vite dev server), every unknown path is a 404.
 */
export async function registerWebApp(
  app: FastifyInstance,
  root: string = DEFAULT_WEB_ROOT,
): Promise<boolean> {
  const indexPath = join(root, "index.html");
  const built = await exists(indexPath);
  let page = "";
  let privatePage = "";
  if (built) {
    page = await readFile(indexPath, "utf8");
    privatePage = page.replace("<head>", `<head>\n    ${NOINDEX}`);
    await app.register(fastifyStatic, {
      root,
      prefix: "/",
      // One route per file of the build, found once at start.
      wildcard: false,
      index: false,
      // The page itself always goes out with its policy, below.
      allowedPath: (path) => path !== "/index.html",
      decorateReply: false,
      setHeaders: (response, path) => {
        response.header(
          "Cache-Control",
          path.includes(`${sep}assets${sep}`)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    });
  } else {
    app.log.info({ root }, "no web build: serving the API only");
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "/";
    const isPage =
      built &&
      (request.method === "GET" || request.method === "HEAD") &&
      !API_PATH.test(path) &&
      !FILE_PATH.test(path);
    if (!isPage) return reply.code(404).send(publicErrorBody(404));
    return reply
      .code(200)
      .header("Content-Security-Policy", DOCUMENT_POLICY)
      .header("Cache-Control", "no-cache")
      .header("Referrer-Policy", "same-origin")
      .header("Cross-Origin-Opener-Policy", "same-origin")
      .type("text/html; charset=utf-8")
      .send(TOKEN_PAGE.test(path) ? privatePage : page);
  });
  return built;
}
