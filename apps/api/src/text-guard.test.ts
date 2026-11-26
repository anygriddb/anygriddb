import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerTextGuard } from "./text-guard.js";
import { baseProcedure as procedure, t } from "./trpc/init.js";
import type { Context } from "./trpc/context.js";

async function server() {
  const app = Fastify();
  registerTextGuard(app);
  app.post("/thing/:id", () => ({ reached: true }));
  app.get("/thing/:id", () => ({ reached: true }));
  await app.register((scope, _options, done) => {
    // As SCIM does: failures answered in the route's own terms.
    scope.setErrorHandler((error: { statusCode?: number }, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ own: true }),
    );
    scope.post("/own", () => ({ reached: true }));
    done();
  });
  await app.ready();
  return app;
}

describe("registerTextGuard", () => {
  it("lets every text a person can write through", async () => {
    const app = await server();
    const response = await app.inject({
      method: "POST",
      url: "/thing/a?search=caf%C3%A9",
      payload: { name: "José 😀", list: ["a\nb"] },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("refuses a NUL or half a pair in a body, a query, or a path", async () => {
    const app = await server();
    for (const request of [
      { method: "POST", url: "/thing/a", payload: '{"name":"a\\u0000b"}' },
      { method: "POST", url: "/thing/a", payload: '{"name":"a\\ud800b"}' },
      { method: "POST", url: "/thing/a", payload: '{"a\\u0000":1}' },
      { method: "GET", url: "/thing/a?filter=a%00b" },
      { method: "GET", url: "/thing/a%00b" },
    ] as const) {
      const response = await app.inject({
        ...request,
        ...("payload" in request
          ? { headers: { "content-type": "application/json" } }
          : {}),
      });
      expect(response.statusCode, request.url).toBe(400);
      expect(response.body).not.toContain("reached");
    }
    await app.close();
  });

  it("gives a route with its own handler the status", async () => {
    const app = await server();
    const response = await app.inject({
      method: "POST",
      url: "/own",
      headers: { "content-type": "application/json" },
      payload: '{"name":"a\\u0000b"}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ own: true });
    await app.close();
  });
});

describe("the base of every procedure", () => {
  const caller = t
    .router({
      write: procedure.input(z.unknown()).mutation(() => "reached"),
    })
    .createCaller({} as Context);

  it("takes a plain input", async () => {
    await expect(caller.write({ name: "José 😀" })).resolves.toBe("reached");
  });

  it("refuses a text nothing can keep, by the public code", async () => {
    for (const input of ["a\u0000b", { a: ["\ud800"] }, { "\u0000": 1 }]) {
      await expect(caller.write(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        cause: { code: "invalid_input" },
      });
    }
  });

  it("leaves what a page read and sends back to compare", async () => {
    await expect(
      caller.write({ values: { a: "new" }, expected: { a: "held\u0000" } }),
    ).resolves.toBe("reached");
    await expect(caller.write({ seen: { a: "held\u0000" } })).resolves.toBe(
      "reached",
    );
  });
});
