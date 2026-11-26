/**
 * Every way in says what it asks: each procedure of the router, each HTTP
 * route of the server as it is built, each MCP tool, each message a page
 * sends on its socket, each task and each kind of job. One that declares
 * nothing, or names an exception this version does not know, fails here
 * by its name. `refused.integration.test.ts` then calls each of them
 * without what it declares.
 */
import { randomBytes } from "node:crypto";
import { JOB_KINDS } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  declarationSchema,
  EXCEPTIONS,
  type Declaration,
} from "../access/declaration.js";
import { registeredRoutes } from "../access/routes.js";
import { readEnv } from "../env.js";
import { createFileStore } from "../files/index.js";
import { JOB_ASKS } from "../job-runners.js";
import { OPERATION_ASKS } from "../public-api/index.js";
import { TASKS } from "../queue/jobs.js";
import { TASK_ASKS } from "../queue/tasks.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createApp } from "../server.js";
import { createTestDatabase } from "../test-database.js";
import { MESSAGE_ASKS } from "../ws.js";
import { walkRouter } from "./router-walk.test-helpers.js";

/** The ways in whose declaration does not have the shape it must. */
function malformed(
  entries: Iterable<readonly [string, unknown]>,
): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const [name, declaration] of entries) {
    const parsed = declarationSchema.safeParse(declaration);
    if (!parsed.success) found.push([name, parsed.error.message]);
  }
  return found;
}

describe("every way in declares what it asks", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let url = "";

  beforeAll(async () => {
    const created = await createTestDatabase("declared");
    db = created.db;
    close = created.close;
    url = created.url;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("every procedure of the router", () => {
    const procedures = walkRouter();
    expect(procedures.length).toBeGreaterThan(300);
    // `walkRouter` parses each declaration, and names the first bad one.
    expect(
      procedures.filter(
        ({ declaration }) => !declarationSchema.safeParse(declaration).success,
      ),
    ).toEqual([]);
  });

  it("every HTTP route of the server, as it starts", async () => {
    const env = readEnv({
      DATABASE_URL: url,
      AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      PUBLIC_URL: "https://grid.example.org",
    });
    const app = await createApp({
      env,
      db,
      bus: recordingBus().bus,
      files: createFileStore(env),
      webRoot: "/nowhere",
    });
    try {
      // A route that declares nothing stops the start: this is that start.
      await app.ready();
      const routes = registeredRoutes(app);
      expect(routes.length).toBeGreaterThan(50);
      expect(
        malformed(
          routes.map(
            (route) =>
              [
                `${String(route.method)} ${route.url}`,
                route.config?.declaration,
              ] as const,
          ),
        ),
      ).toEqual([]);
      // The REST API and the procedures' door are among them.
      const names = new Set(
        routes.map((route) => `${String(route.method)} ${route.url}`),
      );
      expect(names.has("GET /api/v1/tables/:tableId/records")).toBe(true);
      expect([...names].some((name) => name.includes("/trpc/"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("every MCP tool, every socket message, every task and every kind of job", () => {
    expect(malformed(Object.entries(OPERATION_ASKS))).toEqual([]);
    expect(malformed(Object.entries(MESSAGE_ASKS))).toEqual([]);
    expect(malformed(Object.entries(TASK_ASKS))).toEqual([]);
    expect(malformed(Object.entries(JOB_ASKS))).toEqual([]);
    expect(Object.keys(TASK_ASKS).sort()).toEqual(Object.values(TASKS).sort());
    expect(Object.keys(JOB_ASKS).sort()).toEqual([...JOB_KINDS].sort());
  });

  it("refuses a declaration that asks nothing and names no exception", () => {
    expect(declarationSchema.safeParse({}).success).toBe(false);
    expect(declarationSchema.safeParse({ also: ["rows.read"] }).success).toBe(
      false,
    );
    expect(
      declarationSchema.safeParse({ exception: "made up for a test" }).success,
    ).toBe(false);
    expect(declarationSchema.safeParse({ asks: ["rows.read"] }).success).toBe(
      true,
    );
    const open: Declaration = { exception: "signIn" };
    expect(declarationSchema.safeParse(open).success).toBe(true);
    // Each exception says why, in a sentence.
    for (const reason of Object.values(EXCEPTIONS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
