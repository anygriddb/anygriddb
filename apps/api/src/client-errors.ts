/**
 * What a page tells the instance when its code fails in a browser, so the
 * operator learns of a failure people would otherwise meet alone: one line
 * in the log, and a counter on `/metrics`. A page reports to the server it
 * came from and nowhere else.
 *
 * A report is words from a browser. It is bounded, takes no account or
 * session, has its address masked as request addresses are, and is counted
 * in a bucket of its own so a page that fails in a loop cannot flood the
 * log.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publicErrorBody, stripCrlf } from "./http.js";
import { logUrl } from "./log-url.js";
import { clientErrorReported } from "./observability.js";

const CLIENT_ERROR_KINDS = ["render", "error", "rejection"] as const;

const MAX_STACK_LINES = 30;
const MAX_LINE_CHARS = 300;

const reportSchema = z.object({
  /** A page that could not be drawn, an uncaught error, a refused promise. */
  kind: z.enum(CLIENT_ERROR_KINDS),
  message: z.string().max(500),
  stack: z.string().max(8_000).optional(),
  /** The page's path, without its query. */
  path: z.string().max(500),
});

/** A stack as a few short lines: readable in a structured log. */
function stackLines(stack: string | undefined): string[] {
  return (stack ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().slice(0, MAX_LINE_CHARS))
    .filter((line) => line.length > 0)
    .slice(0, MAX_STACK_LINES);
}

/** True when a browser sent the request from another origin than ours. */
function foreign(origin: string | undefined, publicUrl: string): boolean {
  return origin !== undefined && origin !== new URL(publicUrl).origin;
}

export function registerClientErrors(
  app: FastifyInstance,
  deps: { publicUrl: string },
): void {
  app.post(
    "/api/client-errors",
    { bodyLimit: 16_384 },
    async (request, reply) => {
      if (foreign(request.headers.origin, deps.publicUrl)) {
        return reply.code(403).send(publicErrorBody(403));
      }
      const report = reportSchema.safeParse(request.body);
      if (!report.success) {
        return reply.code(400).send(publicErrorBody(400));
      }
      clientErrorReported(report.data.kind);
      request.log.warn(
        {
          client: {
            kind: report.data.kind,
            message: stripCrlf(report.data.message),
            // A share's or an invitation's address is a secret.
            path: logUrl(stripCrlf(report.data.path)),
            stack: stackLines(report.data.stack),
          },
        },
        "page failed in a browser",
      );
      return reply.code(204).send();
    },
  );
}
