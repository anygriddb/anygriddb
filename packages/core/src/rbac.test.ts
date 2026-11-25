import { describe, expect, it } from "vitest";
import {
  can,
  effectiveTableRole,
  enrollmentGate,
  PERMISSIONS,
  type Permission,
  roleFor,
  roleGrants,
  rolePermissions,
  ROLES,
  roleRank,
  type Binding,
} from "./rbac";

const bindings: Binding[] = [
  { role: "viewer", scope: "table", scopeId: "table-1" },
  { role: "editor", scope: "column", scopeId: "column-1" },
];

/**
 * The rank each act asked of a role before permissions were named
 * (viewer 1, commenter 2, editor 3, owner 4). The packs must give each
 * act to exactly the roles that held it then: a role that gains or loses
 * one changes someone's access, and is a decision of its own.
 */
const RANK_BEFORE: Record<Permission, number> = {
  "rows.read": 1,
  "data.export": 1,
  "rows.comment": 2,
  "rows.write": 3,
  "rows.delete": 3,
  "data.import": 3,
  publish: 3,
  "views.manage": 3,
  "rows.lock": 4,
  "dashboards.manage": 4,
  "schema.manage": 4,
  "automations.manage": 4,
  "webhooks.manage": 4,
  "members.manage": 4,
  "base.manage": 4,
};

describe("roleGrants", () => {
  it("gives each role exactly the acts its rank gave", () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(roleGrants(role, permission), `${role} / ${permission}`).toBe(
          roleRank(role) >= RANK_BEFORE[permission],
        );
      }
    }
  });

  it("gives nothing to no role", () => {
    for (const permission of PERMISSIONS) {
      expect(roleGrants(null, permission)).toBe(false);
      expect(roleGrants(undefined, permission)).toBe(false);
    }
  });

  it("lists a pack in the catalogue's order, the owner's whole", () => {
    expect(rolePermissions("viewer")).toEqual(["rows.read", "data.export"]);
    expect(rolePermissions("commenter")).toEqual([
      "rows.read",
      "rows.comment",
      "data.export",
    ]);
    expect(rolePermissions("owner")).toEqual([...PERMISSIONS]);
  });
});

describe("can", () => {
  it("allows a viewer to read only the bound scope", () => {
    expect(can(bindings, "rows.read", "table", "table-1")).toBe(true);
    expect(can(bindings, "rows.write", "table", "table-1")).toBe(false);
    expect(can(bindings, "data.export", "table", "table-1")).toBe(true);
    expect(can(bindings, "publish", "table", "table-1")).toBe(false);
    expect(can(bindings, "rows.read", "table", "table-2")).toBe(false);
    expect(can(bindings, "rows.write", "column", "column-1")).toBe(true);
  });
});

describe("enrollmentGate", () => {
  const owner: Binding[] = [
    { role: "owner", scope: "base", scopeId: "base-1" },
  ];
  const gate = (
    patch: Partial<Parameters<typeof enrollmentGate>[0]> = {},
  ): "ok" | "enroll" =>
    enrollmentGate({
      bindings,
      factors: 0,
      isAdmin: false,
      scope: "owners",
      ...patch,
    });

  it("requires a factor for an owner and for creating a base by default", () => {
    expect(gate({ bindings: owner })).toBe("enroll");
    expect(gate({ bindings: owner, factors: 1 })).toBe("ok");
    expect(gate({ creatingBase: true })).toBe("enroll");
    expect(gate()).toBe("ok");
  });

  it("always requires one of an administrator", () => {
    for (const scope of ["admins", "owners", "everyone"] as const) {
      expect(gate({ isAdmin: true, scope })).toBe("enroll");
      expect(gate({ isAdmin: true, scope, factors: 1 })).toBe("ok");
    }
  });

  it("asks an administrator for one even when the provider vouches", () => {
    expect(gate({ isAdmin: true, providerFactor: true })).toBe("enroll");
    expect(gate({ isAdmin: true, providerFactor: true, factors: 1 })).toBe(
      "ok",
    );
    expect(gate({ scope: "everyone", providerFactor: true })).toBe("ok");
  });

  it("follows the instance's scope for everyone else", () => {
    expect(gate({ scope: "everyone" })).toBe("enroll");
    expect(gate({ scope: "everyone", factors: 2 })).toBe("ok");
    expect(gate({ scope: "admins", bindings: owner })).toBe("ok");
    expect(gate({ scope: "admins", creatingBase: true })).toBe("ok");
  });

  it("counts the identity provider's factor when the instance trusts it", () => {
    expect(gate({ scope: "everyone", providerFactor: true })).toBe("ok");
    expect(gate({ bindings: owner, providerFactor: true })).toBe("ok");
  });
});

describe("roleFor", () => {
  it("keeps the highest role on an exact scope", () => {
    const both: Binding[] = [
      { role: "viewer", scope: "base", scopeId: "base-1" },
      { role: "owner", scope: "base", scopeId: "base-1" },
      { role: "editor", scope: "base", scopeId: "base-2" },
    ];
    expect(roleFor(both, "base", "base-1")).toBe("owner");
    expect(roleFor(both, "base", "missing")).toBeNull();
  });
});

describe("effectiveTableRole", () => {
  it("lets a table override the base role, in both directions", () => {
    const layered: Binding[] = [
      { role: "editor", scope: "base", scopeId: "base-1" },
      { role: "viewer", scope: "table", scopeId: "table-locked" },
      { role: "commenter", scope: "base", scopeId: "base-2" },
    ];
    expect(effectiveTableRole(layered, "table-open", "base-1")).toBe("editor");
    expect(effectiveTableRole(layered, "table-locked", "base-1")).toBe(
      "viewer",
    );
    expect(can(layered, "rows.write", "table", "table-open", "base-1")).toBe(
      true,
    );
    expect(can(layered, "rows.write", "table", "table-locked", "base-1")).toBe(
      false,
    );
    expect(can(layered, "rows.comment", "table", "table-x", "base-2")).toBe(
      true,
    );
    expect(can(layered, "rows.write", "table", "table-x", "base-2")).toBe(
      false,
    );
    expect(can(layered, "rows.read", "table", "table-open")).toBe(false);
  });
});
