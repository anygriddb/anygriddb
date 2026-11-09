/**
 * SCIM 2.0 (RFC 7643, RFC 7644), the part an identity provider needs to
 * keep accounts and groups (ADR 0038): parsing what it sends, and the
 * resources AnyGridDB answers with. No database here.
 */
import { z } from "zod";
import { isEmail } from "./cell-values";
import { labelSchema } from "./names";

export const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_CONFIG =
  "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const SCIM_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const SCIM_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** Results one page of a list holds, at most. */
export const SCIM_MAX_PAGE = 200;
/** Members one group holds, at most. */
export const SCIM_MAX_MEMBERS = 10_000;

export type ScimErrorType =
  | "invalidFilter"
  | "invalidPath"
  | "invalidSyntax"
  | "invalidValue"
  | "mutability"
  | "noTarget"
  | "uniqueness";

/** An answer SCIM defines: a status, and a type for a 400 or a 409. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: ScimErrorType,
  ) {
    super(message);
    this.name = "ScimError";
  }
}

export function scimErrorBody(error: ScimError) {
  return {
    schemas: [SCIM_ERROR],
    status: String(error.status),
    ...(error.scimType ? { scimType: error.scimType } : {}),
    detail: error.message,
  };
}

const invalid = (message: string, type: ScimErrorType = "invalidValue") =>
  new ScimError(400, message, type);

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

/** The attributes a list can be filtered on, by resource. */
const FILTERABLE = {
  user: new Map([
    ["id", "id"],
    ["username", "userName"],
    ["externalid", "externalId"],
    ["emails", "email"],
    ["emails.value", "email"],
    ['emails[type eq "work"].value', "email"],
    ["displayname", "displayName"],
  ]),
  group: new Map([
    ["id", "id"],
    ["externalid", "externalId"],
    ["displayname", "displayName"],
    ["members", "member"],
    ["members.value", "member"],
  ]),
} as const;

export type ScimFilter = { attribute: string; value: string };

/**
 * A list filter: one `attribute eq "value"`, what providers send to find a
 * resource before creating it. Anything else is refused, not ignored.
 */
export function parseScimFilter(
  resource: "user" | "group",
  filter: string | undefined,
): ScimFilter | null {
  if (filter === undefined || filter.trim() === "") return null;
  const match =
    /^\s*([A-Za-z][\w.]*(?:\[\s*type\s+eq\s+"work"\s*\]\.value)?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(
      filter,
    );
  if (!match)
    throw invalid(
      'Only `attribute eq "value"` filters are supported',
      "invalidFilter",
    );
  const name = (match[1] ?? "").toLowerCase().replace(/\s+/g, " ");
  const attribute = FILTERABLE[resource].get(name);
  if (!attribute)
    throw invalid(
      `Unknown filter attribute: ${match[1] ?? ""}`,
      "invalidFilter",
    );
  const value = (match[2] ?? "").replace(/\\(.)/g, "$1");
  return { attribute, value };
}

/** A page: SCIM counts from 1; `count` 0 asks for the total only. */
export function scimPage(query: { startIndex?: unknown; count?: unknown }): {
  offset: number;
  limit: number;
  startIndex: number;
} {
  const number = (value: unknown, fallback: number) => {
    const parsed = typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isInteger(parsed) ? parsed : fallback;
  };
  const startIndex = Math.max(1, number(query.startIndex, 1));
  const limit = Math.min(SCIM_MAX_PAGE, Math.max(0, number(query.count, 100)));
  return { offset: startIndex - 1, limit, startIndex };
}

export function scimList(
  resources: readonly unknown[],
  total: number,
  startIndex: number,
) {
  return {
    schemas: [SCIM_LIST],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

/** A boolean as providers send it: `true`, or the text "True". */
const flagSchema = z.union([
  z.boolean(),
  z
    .string()
    .regex(/^(true|false)$/i)
    .transform((text) => text.toLowerCase() === "true"),
]);

const textSchema = z.string().trim().max(1_000);

const userBodySchema = z
  .object({
    userName: textSchema.min(1),
    externalId: textSchema.optional().nullable(),
    displayName: textSchema.optional().nullable(),
    name: z
      .object({
        formatted: textSchema.optional().nullable(),
        givenName: textSchema.optional().nullable(),
        familyName: textSchema.optional().nullable(),
      })
      .loose()
      .optional()
      .nullable(),
    emails: z
      .array(
        z
          .object({
            value: textSchema,
            primary: flagSchema.optional(),
            type: z.string().optional(),
          })
          .loose(),
      )
      .max(20)
      .optional()
      .nullable(),
    active: flagSchema.optional(),
  })
  .loose();

/** An account as SCIM sees it; `email` is how AnyGridDB knows it. */
export type ScimUserState = {
  userName: string;
  email: string;
  displayName: string;
  externalId: string | null;
  active: boolean;
};

/** A display name AnyGridDB accepts, from the provider's words. */
export function scimDisplayName(
  raw: string | null | undefined,
  email: string,
): string {
  const tidy = (text: string) =>
    text
      .replace(/[^\p{L}\p{N} _.'()&/+:#-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .slice(0, 80)
      .trim();
  for (const candidate of [raw ?? "", email.split("@")[0] ?? ""]) {
    const name = tidy(candidate);
    if (labelSchema.safeParse(name).success) return name;
  }
  return "Utilisateur";
}

/** The email of a user body: its primary email, else its user name. */
function emailOf(body: z.infer<typeof userBodySchema>): string {
  const emails = body.emails ?? [];
  const chosen =
    emails.find((item) => item.primary === true) ??
    emails.find((item) => item.type === "work") ??
    emails[0];
  for (const candidate of [chosen?.value, body.userName]) {
    const email = candidate?.trim().toLowerCase();
    if (email && isEmail(email)) return email;
  }
  throw invalid(
    "The user needs an email address: a primary email or an email as userName",
  );
}

/** A user as a provider creates or replaces it. */
export function parseScimUser(
  body: unknown,
  current?: ScimUserState,
): ScimUserState {
  const parsed = userBodySchema.safeParse(body);
  if (!parsed.success) throw invalid("Invalid user", "invalidSyntax");
  const user = parsed.data;
  const email = emailOf(user);
  const name = user.name;
  const given = [name?.givenName, name?.familyName].filter(Boolean).join(" ");
  return {
    userName: user.userName,
    email,
    displayName: scimDisplayName(
      user.displayName || name?.formatted || given || current?.displayName,
      email,
    ),
    externalId: user.externalId ?? null,
    active: user.active ?? current?.active ?? true,
  };
}

export const scimPatchSchema = z
  .object({
    schemas: z.array(z.string()).refine((list) => list.includes(SCIM_PATCH)),
    Operations: z
      .array(
        z
          .object({
            op: z
              .string()
              .transform((op) => op.toLowerCase())
              .pipe(z.enum(["add", "replace", "remove"])),
            path: z.string().max(500).optional(),
            value: z.unknown().optional(),
          })
          .loose(),
      )
      .min(1)
      .max(1_000),
  })
  .loose();

export type ScimPatchOperation = z.infer<
  typeof scimPatchSchema
>["Operations"][number];

export function parseScimPatch(body: unknown): ScimPatchOperation[] {
  const parsed = scimPatchSchema.safeParse(body);
  if (!parsed.success) throw invalid("Invalid PatchOp", "invalidSyntax");
  return parsed.data.Operations;
}

const textValue = (value: unknown, path: string): string => {
  if (typeof value === "string") return value.trim();
  throw invalid(`${path} takes a text`);
};

/** What an account cannot be without. */
const REQUIRED_USER_PATHS = new Set([
  "active",
  "username",
  "emails",
  "emails.value",
  'emails[type eq "work"].value',
]);

/** Applies a user PatchOp's operations, in order, to what the account is. */
export function patchScimUser(
  current: ScimUserState,
  operations: readonly ScimPatchOperation[],
): ScimUserState {
  const next = { ...current };
  // Name parts an operation set, put together once all have run.
  const names: { display?: string; given?: string; family?: string } = {};
  const set = (rawPath: string, value: unknown, op: string) => {
    const path = rawPath.trim().toLowerCase().replace(/\s+/g, " ");
    if (op === "remove") {
      if (path === "externalid") next.externalId = null;
      else if (REQUIRED_USER_PATHS.has(path)) {
        throw invalid(`${rawPath} cannot be removed`, "mutability");
      }
      // Other attributes are not kept: nothing to remove.
      return;
    }
    switch (path) {
      case "active": {
        const flag = flagSchema.safeParse(value);
        if (!flag.success) throw invalid("active takes a boolean");
        next.active = flag.data;
        return;
      }
      case "username":
        next.userName = textValue(value, rawPath);
        if (!next.userName) throw invalid("userName cannot be empty");
        return;
      case "externalid":
        next.externalId = value === null ? null : textValue(value, rawPath);
        return;
      case "displayname":
      case "name.formatted":
        names.display = textValue(value, rawPath);
        return;
      case "name.givenname":
        names.given = textValue(value, rawPath);
        return;
      case "name.familyname":
        names.family = textValue(value, rawPath);
        return;
      case "name": {
        if (!value || typeof value !== "object")
          throw invalid("name takes an object");
        const name = value as Record<string, unknown>;
        if (typeof name.formatted === "string") names.display = name.formatted;
        if (typeof name.givenName === "string") names.given = name.givenName;
        if (typeof name.familyName === "string") names.family = name.familyName;
        return;
      }
      case "emails":
      case "emails.value":
      case 'emails[type eq "work"].value': {
        const list = Array.isArray(value) ? value : [value];
        const first = list
          .map((item) =>
            typeof item === "string"
              ? item
              : item && typeof item === "object"
                ? (item as { value?: unknown }).value
                : undefined,
          )
          .find((item): item is string => typeof item === "string");
        const email = first?.trim().toLowerCase();
        if (!email || !isEmail(email)) throw invalid("Invalid email");
        next.email = email;
        return;
      }
      default:
        // Attributes AnyGridDB does not keep (title, phone numbers, the
        // enterprise extension, …) are let go, as providers expect.
        return;
    }
  };
  for (const operation of operations) {
    if (operation.path) {
      set(operation.path, operation.value, operation.op);
    } else if (
      operation.op !== "remove" &&
      operation.value &&
      typeof operation.value === "object"
    ) {
      // No path: the value's attributes, each as its own path.
      for (const [key, value] of Object.entries(
        operation.value as Record<string, unknown>,
      )) {
        set(key, value, operation.op);
      }
    } else {
      throw invalid("An operation needs a path or an object value", "noTarget");
    }
  }
  if (
    names.display !== undefined ||
    names.given !== undefined ||
    names.family !== undefined
  ) {
    const parts = [names.given, names.family].filter(Boolean).join(" ");
    next.displayName = scimDisplayName(
      names.display || parts || next.displayName,
      next.email,
    );
  }
  return next;
}

export function scimUserResource(
  user: ScimUserState & {
    id: string;
    created: Date;
    groups?: ReadonlyArray<{ id: string; displayName: string }>;
  },
  baseUrl: string,
) {
  return {
    schemas: [SCIM_USER],
    id: user.id,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    userName: user.userName,
    displayName: user.displayName,
    name: { formatted: user.displayName },
    emails: [{ value: user.email, type: "work", primary: true }],
    active: user.active,
    groups: (user.groups ?? []).map((group) => ({
      value: group.id,
      display: group.displayName,
      $ref: `${baseUrl}/Groups/${group.id}`,
    })),
    meta: {
      resourceType: "User",
      created: user.created.toISOString(),
      lastModified: user.created.toISOString(),
      location: `${baseUrl}/Users/${user.id}`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

const memberSchema = z
  .object({ value: z.string().trim().min(1).max(100) })
  .loose();

const groupBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    externalId: textSchema.optional().nullable(),
    members: z.array(memberSchema).max(SCIM_MAX_MEMBERS).optional().nullable(),
  })
  .loose();

export type ScimGroupState = {
  displayName: string;
  externalId: string | null;
  members: string[];
};

export function parseScimGroup(body: unknown): ScimGroupState {
  const parsed = groupBodySchema.safeParse(body);
  if (!parsed.success) throw invalid("Invalid group", "invalidSyntax");
  return {
    displayName: parsed.data.displayName,
    externalId: parsed.data.externalId ?? null,
    members: [
      ...new Set((parsed.data.members ?? []).map((member) => member.value)),
    ],
  };
}

/** Member ids an operation's value names: `[{ value }]`, one, or ids. */
function memberIds(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return list.map((item) => {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? (item as { value?: unknown }).value
          : undefined;
    if (typeof id !== "string" || id.trim() === "")
      throw invalid("Invalid member");
    return id.trim();
  });
}

/** Applies a group PatchOp's operations, in order. */
export function patchScimGroup(
  current: ScimGroupState,
  operations: readonly ScimPatchOperation[],
): ScimGroupState {
  const next = { ...current, members: [...current.members] };
  const members = new Set(next.members);
  const apply = (op: string, rawPath: string | undefined, value: unknown) => {
    const path = rawPath?.trim() ?? "";
    const one = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (one) {
      if (op !== "remove")
        throw invalid(`Unsupported path: ${path}`, "invalidPath");
      members.delete(one[1] ?? "");
      return;
    }
    switch (path.toLowerCase()) {
      case "members":
        if (op === "replace") members.clear();
        if (op === "remove") {
          // No value removes every member.
          if (value === undefined) members.clear();
          for (const id of memberIds(value)) members.delete(id);
        } else {
          for (const id of memberIds(value)) members.add(id);
        }
        return;
      case "displayname":
        if (op === "remove")
          throw invalid("displayName cannot be removed", "mutability");
        next.displayName = textValue(value, path);
        if (!next.displayName) throw invalid("displayName cannot be empty");
        return;
      case "externalid":
        next.externalId =
          op === "remove" || value === null ? null : textValue(value, path);
        return;
      case "": {
        if (op === "remove" || !value || typeof value !== "object") {
          throw invalid(
            "An operation needs a path or an object value",
            "noTarget",
          );
        }
        for (const [key, inner] of Object.entries(
          value as Record<string, unknown>,
        )) {
          apply(op, key, inner);
        }
        return;
      }
      default:
        throw invalid(`Unsupported path: ${path}`, "invalidPath");
    }
  };
  for (const operation of operations) {
    apply(operation.op, operation.path, operation.value);
  }
  if (members.size > SCIM_MAX_MEMBERS) throw invalid("Too many members");
  next.members = [...members];
  return next;
}

export function scimGroupResource(
  group: {
    id: string;
    displayName: string;
    externalId: string | null;
    created: Date;
    updated: Date;
    members?: ReadonlyArray<{ id: string; displayName: string }>;
  },
  baseUrl: string,
) {
  return {
    schemas: [SCIM_GROUP],
    id: group.id,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    displayName: group.displayName,
    ...(group.members
      ? {
          members: group.members.map((member) => ({
            value: member.id,
            display: member.displayName,
            $ref: `${baseUrl}/Users/${member.id}`,
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: group.created.toISOString(),
      lastModified: group.updated.toISOString(),
      location: `${baseUrl}/Groups/${group.id}`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

export function scimServiceProviderConfig(baseUrl: string) {
  return {
    schemas: [SCIM_CONFIG],
    documentationUri: "https://datatracker.ietf.org/doc/html/rfc7644",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "A provisioning token made in AnyGridDB's administration",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${baseUrl}/ServiceProviderConfig`,
    },
  };
}

export function scimResourceTypes(baseUrl: string) {
  return [
    {
      schemas: [SCIM_RESOURCE_TYPE],
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: SCIM_USER,
      meta: {
        resourceType: "ResourceType",
        location: `${baseUrl}/ResourceTypes/User`,
      },
    },
    {
      schemas: [SCIM_RESOURCE_TYPE],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_GROUP,
      meta: {
        resourceType: "ResourceType",
        location: `${baseUrl}/ResourceTypes/Group`,
      },
    },
  ];
}

const attribute = (
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

export function scimSchemas(baseUrl: string) {
  return [
    {
      schemas: [SCIM_SCHEMA],
      id: SCIM_USER,
      name: "User",
      attributes: [
        attribute("userName", { required: true, uniqueness: "server" }),
        attribute("displayName"),
        attribute("name", {
          type: "complex",
          subAttributes: [
            attribute("formatted"),
            attribute("givenName"),
            attribute("familyName"),
          ],
        }),
        attribute("emails", {
          type: "complex",
          multiValued: true,
          subAttributes: [
            attribute("value"),
            attribute("type"),
            attribute("primary", { type: "boolean" }),
          ],
        }),
        attribute("active", { type: "boolean" }),
        attribute("groups", {
          type: "complex",
          multiValued: true,
          mutability: "readOnly",
          subAttributes: [attribute("value"), attribute("display")],
        }),
      ],
      meta: {
        resourceType: "Schema",
        location: `${baseUrl}/Schemas/${SCIM_USER}`,
      },
    },
    {
      schemas: [SCIM_SCHEMA],
      id: SCIM_GROUP,
      name: "Group",
      attributes: [
        attribute("displayName", { required: true, uniqueness: "server" }),
        attribute("members", {
          type: "complex",
          multiValued: true,
          subAttributes: [attribute("value"), attribute("display")],
        }),
      ],
      meta: {
        resourceType: "Schema",
        location: `${baseUrl}/Schemas/${SCIM_GROUP}`,
      },
    },
  ];
}
