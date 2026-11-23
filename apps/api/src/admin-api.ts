/**
 * The administration API (ADR 0086), under /api/v1/admin: what an
 * operator's script asks of Administration, with a token made for it
 * (`aga_…`) and for the scopes that token names. A token gives no proof,
 * so it does nothing the proof guards on screen: it makes no
 * administrator, gives no role on a base, and changes none of the settings
 * that decide who gets in. What it does goes through the functions
 * Administration's own pages call.
 */
import {
  API_SETTING_KEYS,
  apiSettingsPatchSchema,
  AppError,
  instanceSettingsPatchSchema,
  labelSchema,
  publicError,
  type PublicError,
  trimEndRun,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createAccount, listUsers } from "./admin.js";
import { listPendingInvitations } from "./admin-control.js";
import { welcomeAccount } from "./auth/account-welcome.js";
import {
  ADMIN_SCOPES,
  type AdminScope,
  type AdminTokenActor,
  adminTokenActor,
} from "./auth/admin-tokens.js";
import type { Env } from "./env.js";
import { saveInstanceSettings } from "./instance-settings.js";
import { readSettings } from "./settings.js";

type Deps = {
  db: Database;
  env: Env;
  /** Ends the live connections of an account signed out. */
  closeUser: (userId: string) => void;
};

/** A list's filters, as an address carries them: every value is text. */
const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const accountsQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(["active", "disabled", "locked"]).optional(),
    admin: flag.optional(),
    mfa: flag.optional(),
    origin: z.enum(["local", "sso", "scim"]).optional(),
    sort: z.enum(["name", "email", "created", "lastSeen"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/**
 * A new account: an address and a name, and nothing else. It is no
 * administrator and has no role on a base: both are given on screen, by
 * whoever gives the proof.
 */
const newAccountSchema = z
  .object({ email: z.email().max(254), displayName: labelSchema })
  .strict();

function errorBody(body: PublicError) {
  return {
    error: body.message,
    code: body.code,
    ...(body.detail === undefined ? {} : { detail: body.detail }),
  };
}

/** What a request sent, read by its schema: a mismatch is the caller's. */
function read<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("invalid_input");
  return parsed.data;
}

async function run(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Deps,
  scope: AdminScope,
  body: (actor: AdminTokenActor) => Promise<unknown>,
) {
  let result: unknown;
  try {
    const actor = await adminTokenActor(deps.db, request.headers.authorization);
    if (!actor) {
      return await reply
        .code(401)
        .send(errorBody(publicError(new AppError("unauthenticated"))));
    }
    if (!actor.scopes.includes(scope)) {
      throw new AppError("admin_token_scope", scope);
    }
    result = await body(actor);
  } catch (error) {
    const failed = publicError(error);
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "administration api request failed");
    }
    return reply.code(status).send(errorBody(failed));
  }
  return reply.send(result);
}

export function registerAdminApi(app: FastifyInstance, deps: Deps): void {
  // The document needs no token: it says what a token is for.
  app.get("/api/v1/admin/openapi.json", (_request, reply) =>
    reply.send(adminOpenApi(deps.env.PUBLIC_URL)),
  );

  app.get("/api/v1/admin/accounts", (request, reply) =>
    run(request, reply, deps, "accounts", () =>
      listUsers(deps.db, read(accountsQuerySchema, request.query)),
    ),
  );

  app.post("/api/v1/admin/accounts", (request, reply) =>
    run(request, reply, deps, "accounts", async (actor) => {
      const input = read(newAccountSchema, request.body);
      const created = await createAccount(
        deps.db,
        actor.maker.id,
        { ...input, admin: false, memberships: [] },
        "admin_token",
      );
      request.log.info(
        { actor: actor.maker.id, token: actor.tokenId, target: created.id },
        "account created with an administration token",
      );
      const welcome = await welcomeAccount(
        { db: deps.db, env: deps.env, log: request.log },
        created.id,
        actor.maker,
      );
      return { userId: created.id, ...welcome };
    }),
  );

  app.get("/api/v1/admin/invitations", (request, reply) =>
    run(request, reply, deps, "invitations", async () => ({
      invitations: await listPendingInvitations(deps.db),
    })),
  );

  app.get("/api/v1/admin/settings", (request, reply) =>
    run(request, reply, deps, "settings", () => readSettings(deps.db)),
  );

  app.patch("/api/v1/admin/settings", (request, reply) =>
    run(request, reply, deps, "settings", async (actor) => {
      // A setting that is changed on screen only is named, so that the
      // caller is not left to guess which key was one too many.
      const sent: unknown = request.body;
      if (typeof sent === "object" && sent !== null) {
        const screenOnly = Object.keys(sent).find(
          (key) =>
            key in instanceSettingsPatchSchema.shape &&
            !(API_SETTING_KEYS as readonly string[]).includes(key),
        );
        if (screenOnly) throw new AppError("admin_token_setting", screenOnly);
      }
      const patch = read(apiSettingsPatchSchema, sent);
      const saved = await saveInstanceSettings(
        deps,
        { id: actor.maker.id, ip: request.ip, method: "admin_token" },
        patch,
      );
      request.log.info(
        {
          actor: actor.maker.id,
          token: actor.tokenId,
          keys: Object.keys(patch),
        },
        "instance settings changed with an administration token",
      );
      return saved;
    }),
  );
}

/** A schema as OpenAPI 3.1 takes it: JSON Schema, without its own header. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    io: "input",
  }) as Record<string, unknown>;
  return rest;
}

const ERROR_SCHEMA = {
  type: "object",
  required: ["error", "code"],
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    detail: { type: "string" },
  },
};

const REFUSALS = {
  "400": { description: "What was sent is not what the request takes." },
  "401": {
    description:
      "No token, a token of another kind, one that expired or was revoked, or one whose maker is no longer an active administrator.",
  },
  "403": { description: "The token does not have the scope the request asks." },
  "429": { description: "Too many requests from this address this minute." },
};

/**
 * The API's own description (OpenAPI 3.1): each request, the scope it
 * asks, and what it takes, written from the schemas the requests are read
 * with, so that the document cannot say otherwise than the server does.
 */
function adminOpenApi(publicUrl: string): Record<string, unknown> {
  const filters = jsonSchema(accountsQuerySchema).properties as Record<
    string,
    unknown
  >;
  const asks = (scope: AdminScope) => ({
    security: [{ token: [] }],
    "x-scope": scope,
  });
  const json = (schema: unknown) => ({
    content: { "application/json": { schema } },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "AnyGridDB administration API",
      version: "1",
      description: [
        "What an operator's script asks of Administration. A request carries a token made in Administration (`Authorization: Bearer aga_…`), for the scopes chosen when it was made:",
        ...ADMIN_SCOPES.map((scope) => `- \`${scope}\``),
        "A token works while the administrator who made it is one, and what it does is on the trails under their name. It makes no administrator, gives no role on a base, and changes none of the settings that decide who gets in: those are done on screen.",
      ].join("\n"),
    },
    servers: [{ url: `${trimEndRun(publicUrl, "/")}/api/v1/admin` }],
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer" } },
      schemas: {
        Error: ERROR_SCHEMA,
        NewAccount: jsonSchema(newAccountSchema),
        SettingsPatch: jsonSchema(apiSettingsPatchSchema),
      },
    },
    paths: {
      "/accounts": {
        get: {
          summary: "List the accounts, a page at a time",
          ...asks("accounts"),
          parameters: Object.entries(filters).map(([name, schema]) => ({
            name,
            in: "query",
            required: false,
            schema,
          })),
          responses: {
            "200": {
              description:
                "A page of accounts and how many match. Never a secret.",
              ...json({
                type: "object",
                required: ["users", "total"],
                properties: {
                  users: { type: "array", items: { type: "object" } },
                  total: { type: "integer" },
                },
              }),
            },
            ...REFUSALS,
          },
        },
        post: {
          summary: "Make an account, which sets its own password",
          description:
            "The account is no administrator and has no role on a base. Where mail is set up, a link that sets its first password is mailed to its address (`sent: true`); where it is not, the link comes back in the answer, once (`sent: false`).",
          ...asks("accounts"),
          requestBody: {
            required: true,
            ...json({ $ref: "#/components/schemas/NewAccount" }),
          },
          responses: {
            "200": {
              description: "The account's id, and where its first link went.",
              ...json({
                type: "object",
                required: ["userId", "sent"],
                properties: {
                  userId: { type: "string", format: "uuid" },
                  sent: { type: "boolean" },
                  to: { type: "string" },
                  link: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              }),
            },
            ...REFUSALS,
            "409": { description: "An account has this address already." },
          },
        },
      },
      "/invitations": {
        get: {
          summary: "List the invitations that wait for an answer",
          ...asks("invitations"),
          responses: {
            "200": {
              description: "The two hundred most recent, with their base.",
              ...json({
                type: "object",
                required: ["invitations"],
                properties: {
                  invitations: { type: "array", items: { type: "object" } },
                },
              }),
            },
            ...REFUSALS,
          },
        },
      },
      "/settings": {
        get: {
          summary: "Read the instance's settings",
          ...asks("settings"),
          responses: {
            "200": {
              description: "Every setting. Never a secret.",
              ...json({ type: "object" }),
            },
            ...REFUSALS,
          },
        },
        patch: {
          summary: "Change the settings an operator's script has cause to",
          description: `Only these: ${API_SETTING_KEYS.map((key) => `\`${key}\``).join(", ")}. Any other key is refused. A setting the instance's environment holds is refused too (409).`,
          ...asks("settings"),
          requestBody: {
            required: true,
            ...json({ $ref: "#/components/schemas/SettingsPatch" }),
          },
          responses: {
            "200": {
              description: "Every setting, as it is now.",
              ...json({ type: "object" }),
            },
            ...REFUSALS,
            "409": {
              description: "The instance's environment holds this setting.",
            },
          },
        },
      },
    },
  };
}
