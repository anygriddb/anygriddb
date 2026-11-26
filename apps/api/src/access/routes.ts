/**
 * What each HTTP route asks, in its `config`: every route runs under its
 * declaration, and a server with a route that declares nothing does not
 * start.
 */
import type {
  FastifyInstance,
  RouteHandlerMethod,
  RouteOptions,
} from "fastify";
import { type Declaration, runDeclared } from "./declaration.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** What the route asks (`access/declaration.ts`). */
    declaration?: Declaration;
  }
}

/** A route's options with what it asks. */
export function declaredRoute(declaration: Declaration) {
  return { config: { declaration } };
}

/** A route as it was registered: for the test that walks them. */
export type RegisteredRoute = Pick<RouteOptions, "method" | "url" | "config">;

const registered = new WeakMap<FastifyInstance, RouteOptions[]>();

/** The routes `declareRoutes` saw registered on `app`. */
export function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  return registered.get(app) ?? [];
}

/**
 * Runs every route of `app` under its declaration, and refuses to start
 * while one declares nothing.
 */
export function declareRoutes(app: FastifyInstance): void {
  const routes: RouteOptions[] = [];
  registered.set(app, routes);
  app.addHook("onRoute", (route) => {
    routes.push(route);
    // A socket's door is answered by its socket; each message declares.
    if (route.websocket) return;
    const handler = route.handler as RouteHandlerMethod;
    route.handler = function (this: FastifyInstance, request, reply) {
      // Read when called: a door set below this one gives it after.
      const declaration = request.routeOptions.config.declaration ?? {};
      return runDeclared(
        `${request.method} ${request.routeOptions.url ?? request.url}`,
        declaration,
        () => handler.call(this, request, reply),
        (message) => {
          request.log.warn(message);
        },
      );
    };
  });
  app.addHook("onReady", (done) => {
    const bare = routes
      .filter((route) => route.config?.declaration === undefined)
      .map((route) => `${String(route.method)} ${route.url}`);
    done(
      bare.length > 0
        ? new Error(`Routes declare nothing they ask: ${bare.join(", ")}`)
        : undefined,
    );
  });
}

/**
 * Gives every route registered in `scope` that declares nothing this
 * declaration: a plugin's routes (the application's files, the
 * procedures' door, the directory's) are one door.
 */
export function doorTo(scope: FastifyInstance, declaration: Declaration): void {
  scope.addHook("onRoute", (route) => {
    if (route.config?.declaration !== undefined) return;
    route.config = { ...route.config, declaration };
  });
}
