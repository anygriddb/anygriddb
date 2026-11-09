/**
 * SCIM 2.0 against a real database: what an identity provider sends, and
 * what it does to accounts, groups, and the access groups give.
 */
import { randomBytes } from "node:crypto";
import { roleFor } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { listMembers, revokeMember } from "../data/members.js";
import { insertBase } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { setGroupRole } from "./groups.js";
import { registerScim } from "./routes.js";
import { createScimToken, revokeScimToken } from "./tokens.js";

const suffix = randomBytes(6).toString("hex");
const SCIM = "application/scim+json";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

type Json = Record<string, unknown> & {
  id?: string;
  totalResults?: number;
  Resources?: Json[];
  scimType?: string;
  active?: boolean;
  members?: Array<{ value: string }>;
};

describe("SCIM 2.0", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let admin = "";
  let baseId = "";
  let token = "";
  let tokenId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("scim");
    db = created.db;
    close = created.close;
    admin = (
      await db
        .insertInto("users")
        .values({
          email: `admin-${suffix}@corp.example`,
          displayName: "Admin",
          isAdmin: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(db, admin, { name: "Ventes" })).id;
    ({ token, id: tokenId } = await createScimToken(db, admin, "Okta"));
    app = Fastify();
    registerScim(app, { db, publicUrl: "https://grid.example" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  async function call(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    bearer: string | null = token,
  ) {
    const response = await app.inject({
      method,
      url: `/scim/v2${url}`,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        // As some providers do: a content type even without a body.
        "content-type": SCIM,
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return {
      status: response.statusCode,
      type: response.headers["content-type"],
      location: response.headers.location,
      body: (response.body ? JSON.parse(response.body) : {}) as Json,
    };
  }

  const role = async (userId: string) =>
    roleFor(await loadBindings(db, userId), "base", baseId);

  it("answers only a valid token, in SCIM's terms", async () => {
    const none = await call("GET", "/Users", undefined, null);
    expect(none.status).toBe(401);
    expect(none.body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
    expect(
      (await call("GET", "/Users", undefined, `agscim_${"x".repeat(43)}`))
        .status,
    ).toBe(401);
    const config = await call("GET", "/ServiceProviderConfig");
    expect(config.status).toBe(200);
    expect(config.type).toContain(SCIM);
    expect(config.body.patch).toEqual({ supported: true });
    expect((await call("GET", "/Nope")).status).toBe(404);
    expect(
      (await call("GET", '/Users?filter=title eq "x"')).body.scimType,
    ).toBe("invalidFilter");
  });

  let ada = "";
  let eve = "";

  it("creates, finds, changes, and deactivates an account", async () => {
    const userName = `ada-${suffix}@corp.example`;
    const filter = `/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`;
    expect((await call("GET", filter)).body.totalResults).toBe(0);
    const created = await call("POST", "/Users", {
      schemas: [USER],
      userName,
      externalId: "00u-ada",
      name: { givenName: "Ada", familyName: "Lovelace" },
      emails: [{ value: userName, type: "work", primary: true }],
      active: true,
    });
    expect(created.status).toBe(201);
    ada = created.body.id ?? "";
    expect(created.location).toBe(`https://grid.example/scim/v2/Users/${ada}`);
    expect(created.body).toMatchObject({
      userName,
      displayName: "Ada Lovelace",
      active: true,
    });
    expect(
      (await call("POST", "/Users", { schemas: [USER], userName })).body
        .scimType,
    ).toBe("uniqueness");
    const found = await call("GET", filter);
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources?.[0]?.id).toBe(ada);

    await db
      .insertInto("sessions")
      .values({
        userId: ada,
        tokenHash: `session-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .execute();
    const off = await call("PATCH", `/Users/${ada}`, {
      schemas: [PATCH],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const account = await db
      .selectFrom("users")
      .select(["disabledAt", "email", "displayName"])
      .where("id", "=", ada)
      .executeTakeFirstOrThrow();
    expect(account.disabledAt).not.toBeNull();
    expect(
      await db
        .selectFrom("sessions")
        .select("id")
        .where("userId", "=", ada)
        .execute(),
    ).toEqual([]);

    const replaced = await call("PUT", `/Users/${ada}`, {
      schemas: [USER],
      userName,
      displayName: "Ada King",
      emails: [{ value: `ada.king-${suffix}@corp.example`, primary: true }],
      active: true,
    });
    expect(replaced.body).toMatchObject({
      displayName: "Ada King",
      active: true,
      emails: [
        {
          value: `ada.king-${suffix}@corp.example`,
          type: "work",
          primary: true,
        },
      ],
    });
  });

  it("takes over an account made before SCIM, by its email", async () => {
    eve = (
      await db
        .insertInto("users")
        .values({ email: `eve-${suffix}@corp.example`, displayName: "Eve" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const adopted = await call("POST", "/Users", {
      schemas: [USER],
      userName: `EVE-${suffix}@corp.example`,
      externalId: "00u-eve",
    });
    expect(adopted.status).toBe(201);
    expect(adopted.body.id).toBe(eve);
  });

  let groupId = "";

  it("gives a group's members the role a base gives the group", async () => {
    const group = await call("POST", "/Groups", {
      schemas: [GROUP],
      displayName: `Ventes ${suffix}`,
      members: [{ value: ada }],
    });
    expect(group.status).toBe(201);
    groupId = group.body.id ?? "";
    expect(group.body.members?.map((member) => member.value)).toEqual([ada]);
    expect(await role(ada)).toBeNull();

    await setGroupRole(db, admin, { baseId, groupId, role: "editor" });
    expect(await role(ada)).toBe("editor");
    expect(await listMembers(db, baseId)).toContainEqual(
      expect.objectContaining({
        userId: ada,
        role: "editor",
        direct: false,
        groups: [`Ventes ${suffix}`],
      }),
    );

    // Okta adds, Entra ID removes by filter: access follows at once.
    expect(
      (
        await call("PATCH", `/Groups/${groupId}`, {
          schemas: [PATCH],
          Operations: [
            { op: "add", path: "members", value: [{ value: eve }] },
            { op: "remove", path: `members[value eq "${ada}"]` },
          ],
        })
      ).status,
    ).toBe(204);
    expect(await role(eve)).toBe("editor");
    expect(await role(ada)).toBeNull();

    // A base owner's removal touches the person's own role, not the group's.
    await revokeMember(db, admin, { baseId, userId: eve });
    expect(await role(eve)).toBe("editor");
    await setGroupRole(db, admin, { baseId, groupId, role: "viewer" });
    expect(await role(eve)).toBe("viewer");

    const listed = await call(
      "GET",
      `/Groups?filter=${encodeURIComponent(`displayName eq "ventes ${suffix}"`)}&excludedAttributes=members`,
    );
    expect(listed.body.totalResults).toBe(1);
    expect(listed.body.Resources?.[0]?.members).toBeUndefined();
    expect(
      (
        await call("PATCH", `/Groups/${groupId}`, {
          schemas: [PATCH],
          Operations: [
            {
              op: "add",
              path: "members",
              value: [{ value: "9b2f0000-0000-4000-8000-000000000000" }],
            },
          ],
        })
      ).body.scimType,
    ).toBe("invalidValue");
  });

  it("removes an account: disabled, out of its groups, gone from SCIM", async () => {
    expect((await call("DELETE", `/Users/${eve}`)).status).toBe(204);
    expect((await call("GET", `/Users/${eve}`)).status).toBe(404);
    expect(await role(eve)).toBeNull();
    const removed = await db
      .selectFrom("users")
      .select(["disabledAt", "deprovisionedAt"])
      .where("id", "=", eve)
      .executeTakeFirstOrThrow();
    expect(removed.disabledAt).not.toBeNull();
    expect(removed.deprovisionedAt).not.toBeNull();
    // Created again, it comes back: active, without its old groups.
    const back = await call("POST", "/Users", {
      schemas: [USER],
      userName: `eve-${suffix}@corp.example`,
    });
    expect(back.body).toMatchObject({ id: eve, active: true, groups: [] });
  });

  it("keeps an active administrator, and deletes groups with their access", async () => {
    const locked = await call("PATCH", `/Users/${admin}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(locked.status).toBe(400);
    expect(locked.body.scimType).toBe("mutability");
    expect((await call("DELETE", `/Users/${admin}`)).status).toBe(400);

    await call("PATCH", `/Groups/${groupId}`, {
      schemas: [PATCH],
      Operations: [{ op: "add", path: "members", value: [{ value: ada }] }],
    });
    expect(await role(ada)).toBe("viewer");
    expect((await call("DELETE", `/Groups/${groupId}`)).status).toBe(204);
    expect(await role(ada)).toBeNull();
    expect((await call("GET", `/Groups/${groupId}`)).status).toBe(404);
    const trail = await db
      .selectFrom("auditEvents")
      .select("newValue")
      .where("action", "=", "catalog")
      .where("userId", "=", admin)
      .execute();
    // The token's creation is in the trail, without its hash.
    expect(JSON.stringify(trail)).not.toContain("token_hash");
    expect(JSON.stringify(trail)).toContain('"name":"Okta"');
  });

  it("stops a revoked token, and one whose administrator is no longer one", async () => {
    const other = await createScimToken(db, admin, "Entra");
    await revokeScimToken(db, admin, tokenId);
    expect((await call("GET", "/Users")).status).toBe(401);
    expect((await call("GET", "/Users", undefined, other.token)).status).toBe(
      200,
    );
    await db
      .updateTable("users")
      .set({ isAdmin: false })
      .where("id", "=", admin)
      .execute();
    expect((await call("GET", "/Users", undefined, other.token)).status).toBe(
      401,
    );
  });
});
