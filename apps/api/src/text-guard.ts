import { AppError, holdsUnwritableText } from "@anygriddb/core";
import type { FastifyInstance } from "fastify";

/**
 * Refuses a text nothing can keep, on every route that is not a procedure:
 * those ask where their input is read (`trpc/init.ts`). The status rides on
 * the error for the routes that answer failures in their own terms.
 */
export function registerTextGuard(app: FastifyInstance): void {
  app.addHook("preHandler", (request, _reply, done) => {
    const unwritable =
      !request.url.startsWith("/trpc/") &&
      (holdsUnwritableText(request.query) ||
        holdsUnwritableText(request.params) ||
        holdsUnwritableText(request.body));
    done(
      unwritable
        ? Object.assign(new AppError("invalid_input"), { statusCode: 400 })
        : undefined,
    );
  });
}
