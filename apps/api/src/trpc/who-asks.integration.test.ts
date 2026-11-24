/**
 * Who asks comes first. A procedure that needs a session answers
 * "unauthenticated" to a caller without one, whatever it is asked about:
 * it does not look the object up first, which would tell a stranger
 * whether an id names anything, and would let a request with no session
 * reach the tables. Checked on every procedure of the router, not on a
 * list of them: each is called without a session, with an input of the
 * shape it takes, about ids nobody has.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  errorCode as code,
  type TestBrowser,
} from "./caller.test-helpers.js";
import { appRouter } from "./router.js";

/**
 * What answers someone who is not signed in, on purpose: signing in and
 * up, what the sign-in page shows, and what a public link opens. A name
 * joins this list for such a reason, never to make the walk pass.
 */
const OPEN: readonly string[] = [
  "auth.challenge",
  "auth.confirmSignup",
  "auth.instance",
  "auth.invitation",
  "auth.login",
  "auth.logout",
  "auth.requestPasswordReset",
  "auth.resetLink",
  "auth.resetPassword",
  "auth.signup",
  "auth.signupLink",
  "session.current",
  "session.providers",
  "share.baseRows",
  "share.open",
  "share.openBase",
  "share.rows",
  "share.submit",
  "share.unlock",
  "share.unlockBase",
  // A mail's unsubscribe link adjusts one preference without a session
  // (ADR 0123); the token is signed and names the person.
  "notifications.unsubscribe",
];

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  format?: string;
  contentEncoding?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
};

/** Texts tried against a pattern, the plainest first. */
const TEXTS = [
  "asked",
  "000000",
  "A".repeat(16),
  "a".repeat(22),
  "a".repeat(43),
];

function text(schema: Schema): string {
  switch (schema.format) {
    case "uuid":
      return randomUUID();
    case "email":
      return "nobody@example.org";
    case "uri":
    case "url":
      return "https://example.org/";
    case "date-time":
      return "2026-01-01T00:00:00.000Z";
    case "date":
      return "2026-01-01";
    default:
  }
  if (schema.format === "base64" || schema.contentEncoding === "base64") {
    return "YXNrZWQ=";
  }
  if (schema.pattern !== undefined) {
    const pattern = new RegExp(schema.pattern, "u");
    const fits = TEXTS.find(
      (candidate) =>
        pattern.test(candidate) &&
        candidate.length >= (schema.minLength ?? 0) &&
        candidate.length <= (schema.maxLength ?? candidate.length),
    );
    if (fits === undefined) {
      throw new Error(`No text of the walk fits ${schema.pattern}`);
    }
    return fits;
  }
  return "asked"
    .padEnd(schema.minLength ?? 0, "x")
    .slice(0, schema.maxLength ?? 80);
}

/** A value of the shape a schema asks for: what it requires, nothing more. */
function sample(schema: Schema | undefined): unknown {
  if (!schema) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  const choice = schema.anyOf ?? schema.oneOf;
  if (choice && choice.length > 0) {
    return sample(choice.find((option) => option.type !== "null") ?? choice[0]);
  }
  if (schema.allOf) {
    return Object.assign({}, ...schema.allOf.map((part) => sample(part)));
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((name) => name !== "null")
    : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).map((name) => [
          name,
          sample(schema.properties?.[name]),
        ]),
      );
    case "array":
      return Array.from({ length: Math.max(schema.minItems ?? 0, 1) }, () =>
        sample(schema.items),
      );
    case "string":
      return text(schema);
    case "integer":
    case "number":
      return (
        schema.minimum ??
        (schema.exclusiveMinimum === undefined
          ? 1
          : schema.exclusiveMinimum + 1)
      );
    case "boolean":
      return false;
    default:
      return null;
  }
}

/**
 * Inputs a shape alone does not give: a rule of the schema asks that two
 * of its parts agree, or that a text be an address.
 */
const BY_HAND: Record<string, unknown> = {
  "admin.oauthClients.create": {
    name: "Asked",
    redirectUris: ["https://client.example.org/back"],
  },
  "catalog.createTable": {
    baseId: randomUUID(),
    name: "Asked",
    columns: [{ name: "asked", fieldType: "text" }],
  },
  "catalog.createWebhook": {
    tableId: randomUUID(),
    kind: "http",
    target: "https://hooks.example.org/in",
    events: ["insert"],
  },
  "catalog.importAirtable": {
    base: `app${"a".repeat(14)}`,
    token: `pat${"a".repeat(20)}`,
  },
  "dashboards.upsertWidget": {
    dashboardId: randomUUID(),
    title: "Asked",
    kind: "metric",
    config: { tableId: randomUUID(), column: "asked", fn: "count_all" },
  },
  "rows.setLinks": {
    tableId: randomUUID(),
    rowId: randomUUID(),
    column: "asked",
    targetIds: [],
  },
  "rows.importCommit": {
    importId: "a".repeat(22),
    target: { kind: "new", baseId: randomUUID(), name: "Asked" },
    mapping: [{ source: 0, create: { label: "Asked", fieldType: "text" } }],
  },
};

/** Every procedure of the router, with an input it takes. */
const PROCEDURES = Object.entries(
  appRouter._def.procedures as unknown as Record<
    string,
    { _def: { inputs?: unknown[] } }
  >,
).map(([path, procedure]) => {
  const input = procedure._def.inputs?.[0];
  return {
    path,
    input:
      BY_HAND[path] ??
      (input === undefined
        ? undefined
        : sample(
            z.toJSONSchema(input as z.ZodType, {
              unrepresentable: "any",
              io: "input",
            }) as Schema,
          )),
  };
});

describe("who asks comes first", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });

  /** Calls a procedure by its path, from a browser. */
  const ask = (page: TestBrowser, path: string, input: unknown) => {
    let target: unknown = page.call();
    for (const step of path.split(".")) {
      target = (target as Record<string, unknown>)[step];
    }
    return (target as (input?: unknown) => Promise<unknown>)(input);
  };

  beforeAll(async () => {
    const created = await createTestDatabase("whoasks");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("knows every name it lets through", () => {
    const known = new Set(PROCEDURES.map((procedure) => procedure.path));
    expect(PROCEDURES.length).toBeGreaterThan(300);
    expect(OPEN.filter((path) => !known.has(path))).toEqual([]);
    expect(Object.keys(BY_HAND).filter((path) => !known.has(path))).toEqual([]);
  });

  it("tells a stranger that they are not signed in, and nothing of what they asked about", async () => {
    // An input the procedure refuses proves nothing: the walk must get in.
    const stranger = browser();
    const notReached: string[] = [];
    const told: Array<[string, string]> = [];
    for (const { path, input } of PROCEDURES) {
      if (OPEN.includes(path)) continue;
      const answer = await code(ask(stranger, path, input));
      if (answer === "BAD_REQUEST") notReached.push(path);
      else if (answer !== "UNAUTHORIZED") told.push([path, answer]);
    }
    expect(notReached).toEqual([]);
    expect(told).toEqual([]);
  }, 120_000);

  it("tells an account that has still to set up its second factor that, and nothing of what it asked about", async () => {
    // The first account administers the instance, and an administrator
    // needs a second factor whatever the policy says of the others.
    const page = browser();
    await page.signUpFirst({
      email: "first@example.org",
      displayName: "First Account",
      password: "correct horse battery staple",
    });
    const told: Array<[string, string]> = [];
    for (const { path, input } of PROCEDURES) {
      // What an account does about itself works before its second
      // factor: that is how one is set up.
      if (OPEN.includes(path) || /^(auth|session)\./.test(path)) continue;
      const answer = await code(ask(page, path, input));
      // A change of Administration asks for the proof before all else.
      if (answer === "mfa_enrollment_required") continue;
      if (answer === "step_up_required" && path.startsWith("admin.")) continue;
      told.push([path, answer]);
    }
    expect(told).toEqual([]);
  }, 120_000);
});
