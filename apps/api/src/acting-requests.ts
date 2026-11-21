import type { Database } from "@anygriddb/db";
import type { FastifyInstance } from "fastify";
import { actingOf } from "./auth/access.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { runActing } from "./data/acting-context.js";

/**
 * On the REST API, attachments and transfers, a session acting as someone
 * reads by that person's rules and names them on what it writes (ADR 0091).
 * The app's procedures ask for themselves: each is one call of a batch.
 */
export function registerActingRequests(
  app: FastifyInstance,
  db: Database,
): void {
  app.addHook("preHandler", (request, _reply, done) => {
    if (!request.url.startsWith("/api/")) {
      done();
      return;
    }
    actingOf(
      db,
      request.headers.authorization,
      request.cookies[SESSION_COOKIE],
    ).then(
      (acting) => {
        runActing(acting, () => {
          done();
        });
      },
      (error: unknown) => {
        done(error instanceof Error ? error : new Error("acting lookup"));
      },
    );
  });
}
