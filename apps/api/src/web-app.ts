/**
 * The web app, served on the API's own origin (ADR 0011). Built files are
 * served as they are, or as the compressed copy the build made of them,
 * hashed ones under /assets cached for a year. Every
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
const API_PATH = /^\/(?:api|trpc|auth|ws|health|ready)(?:\/|$)/;
/** A missing file, such as a chunk of an older build: a 404, not a page. */
const FILE_PATH = /\/[^/]*\.[A-Za-z0-9]+$/;
/** Pages reached by a secret link: search engines must not keep them. */
const TOKEN_PAGE = /^\/(?:s|invite|reset|signup)\//;
/** A public share page: may soften frame-ancestors when the share opts in. */
const SHARE_PAGE = /^\/s\/([A-Za-z0-9_-]{32,64})\/?$/;

/**
 * Scripts come from this origin only, with no inline code. Styles allow
 * inline attributes: the grid positions rows with `style`, and toasts
 * insert their stylesheet.
 */
const DOCUMENT_DIRECTIVES = [
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
] as const;

/**
 * The document's policy. Nothing frames the app, but a public share
 * whose link names the sites that may (ADR 0067): those and no other.
 */
export function documentPolicy(
  embedOrigins?: readonly string[] | null,
): string {
  const ancestors =
    embedOrigins && embedOrigins.length > 0 ? embedOrigins.join(" ") : "'none'";
  return [...DOCUMENT_DIRECTIVES, `frame-ancestors ${ancestors}`].join("; ");
}

export const DOCUMENT_POLICY = documentPolicy();

/** The sites that may frame the share behind a link; null for none. */
export type ShareEmbedLookup = (
  token: string,
) => Promise<readonly string[] | null>;

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
  shareEmbedOrigins?: ShareEmbedLookup,
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
      // The build leaves a Brotli and a gzip copy beside each text file:
      // the one the browser accepts goes out, and they are no pages of
      // their own.
      preCompressed: true,
      globIgnore: ["**/*.br", "**/*.gz"],
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

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "/";
    const isPage =
      built &&
      (request.method === "GET" || request.method === "HEAD") &&
      !API_PATH.test(path) &&
      !FILE_PATH.test(path);
    if (!isPage) return reply.code(404).send(publicErrorBody(404));
    // A share's page may be framed by the sites its link names. When
    // they cannot be read, it is framed by none.
    const token = shareEmbedOrigins ? SHARE_PAGE.exec(path)?.[1] : undefined;
    const origins =
      token && shareEmbedOrigins
        ? await shareEmbedOrigins(token).catch((error: unknown) => {
            request.log.error({ err: error }, "share embed lookup failed");
            return null;
          })
        : null;
    const policy = documentPolicy(origins);
    // Browsers that know frame-ancestors ignore this header; the others
    // must not be told to refuse what the policy allows.
    if (origins && origins.length > 0) reply.removeHeader("X-Frame-Options");
    return reply
      .code(200)
      .header("Content-Security-Policy", policy)
      .header("Cache-Control", "no-cache")
      .header("Referrer-Policy", "same-origin")
      .header("Cross-Origin-Opener-Policy", "same-origin")
      .type("text/html; charset=utf-8")
      .send(TOKEN_PAGE.test(path) ? privatePage : page);
  });
  return built;
}
