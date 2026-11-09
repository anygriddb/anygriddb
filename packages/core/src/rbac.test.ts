import { describe, expect, it } from "vitest";
import {
  can,
  effectiveTableRole,
  enrollmentGate,
  roleFor,
  type Binding,
} from "./rbac";

const bindings: Binding[] = [
  { role: "viewer", scope: "table", scopeId: "table-1" },
  { role: "editor", scope: "column", scopeId: "column-1" },
];

describe("can", () => {
  it("allows a viewer to read only the bound scope", () => {
    expect(can(bindings, "read", "table", "table-1")).toBe(true);
    expect(can(bindings, "write", "table", "table-1")).toBe(false);
    expect(can(bindings, "read", "table", "table-2")).toBe(false);
    expect(can(bindings, "write", "column", "column-1")).toBe(true);
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

  it("follows the instance's scope for everyone else", () => {
    expect(gate({ scope: "everyone" })).toBe("enroll");
    expect(gate({ scope: "everyone", factors: 2 })).toBe("ok");
    expect(gate({ scope: "admins", bindings: owner })).toBe("ok");
    expect(gate({ scope: "admins", creatingBase: true })).toBe("ok");
  });

  it("counts the identity provider's factor when the instance trusts it", () => {
    expect(gate({ isAdmin: true, providerFactor: true })).toBe("ok");
    expect(gate({ scope: "everyone", providerFactor: true })).toBe("ok");
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
    expect(can(layered, "write", "table", "table-open", "base-1")).toBe(true);
    expect(can(layered, "write", "table", "table-locked", "base-1")).toBe(
      false,
    );
    expect(can(layered, "comment", "table", "table-x", "base-2")).toBe(true);
    expect(can(layered, "write", "table", "table-x", "base-2")).toBe(false);
    expect(can(layered, "read", "table", "table-open")).toBe(false);
  });
});
