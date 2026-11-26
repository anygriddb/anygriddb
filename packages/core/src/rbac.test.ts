import { describe, expect, it } from "vitest";
import {
  callersHold,
  callersPermissions,
  can,
  effectiveTableRole,
  enrollmentGate,
  INSTANCE_PERMISSIONS,
  instanceCallers,
  madePermissions,
  type MadeRole,
  mayGive,
  PERMISSIONS,
  type Permission,
  readOnlyGiven,
  roleFor,
  roleGrants,
  rolePermissions,
  roleRank,
  tableRules,
  tokenGiven,
  type Binding,
  type Role,
} from "./rbac";
import type { FilterGroup } from "./filter";

/** The four of a rank, which every role before 0.12 was. */
const RANKED = ["owner", "editor", "commenter", "viewer"] as const;

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
  // A token reached all its owner's role read before it was named.
  "api.access": 1,
  "rows.comment": 2,
  "rows.write": 3,
  // An editor submitted a draft, its first step, before it was named.
  "rows.transition": 3,
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
  it("gives each of the four exactly the acts its rank gave", () => {
    for (const role of RANKED) {
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
    expect(rolePermissions("viewer")).toEqual([
      "rows.read",
      "data.export",
      "api.access",
    ]);
    expect(rolePermissions("commenter")).toEqual([
      "rows.read",
      "rows.comment",
      "data.export",
      "api.access",
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
  it("adds a table's role to its base's, and never takes from it", () => {
    const layered: Binding[] = [
      { role: "editor", scope: "base", scopeId: "base-1" },
      { role: "viewer", scope: "table", scopeId: "table-lower" },
      { role: "commenter", scope: "base", scopeId: "base-2" },
      { role: "owner", scope: "table", scopeId: "table-higher" },
    ];
    expect(effectiveTableRole(layered, "table-open", "base-1")).toBe("editor");
    // A lower role on a table leaves the base's whole.
    expect(effectiveTableRole(layered, "table-lower", "base-1")).toBe("editor");
    expect(can(layered, "rows.write", "table", "table-lower", "base-1")).toBe(
      true,
    );
    expect(effectiveTableRole(layered, "table-higher", "base-2")).toBe("owner");
    expect(can(layered, "rows.write", "table", "table-x", "base-2")).toBe(
      false,
    );
    expect(can(layered, "rows.read", "table", "table-open")).toBe(false);
  });
});

const REVIEWER: MadeRole = {
  id: "made-1",
  name: "Reviewer",
  permissions: ["rows.read", "rows.comment", "rows.lock"],
};
const STEWARD: MadeRole = {
  id: "made-2",
  name: "Steward",
  permissions: ["rows.read", "members.manage", "schema.manage"],
};

describe("made roles", () => {
  it("give what they hold, and nothing else", () => {
    expect(roleGrants(REVIEWER, "rows.lock")).toBe(true);
    expect(roleGrants(REVIEWER, "rows.write")).toBe(false);
    expect(roleGrants(REVIEWER, "data.export")).toBe(false);
  });

  it("add up with the four on one scope, and an owner holds it all", () => {
    const held = roleFor(
      [
        { role: "viewer", scope: "base", scopeId: "b" },
        { role: REVIEWER, scope: "base", scopeId: "b" },
      ],
      "base",
      "b",
    );
    expect(held).toEqual({
      role: "viewer",
      shipped: [],
      made: [{ id: "made-1", name: "Reviewer" }],
      permissions: [
        "rows.read",
        "rows.comment",
        "rows.lock",
        "data.export",
        "api.access",
      ],
    });
    expect(
      roleFor(
        [
          { role: REVIEWER, scope: "base", scopeId: "b" },
          { role: "owner", scope: "base", scopeId: "b" },
        ],
        "base",
        "b",
      ),
    ).toBe("owner");
  });

  it("add to the base's role on a table, made or not", () => {
    const bindings: Binding[] = [
      { role: "editor", scope: "base", scopeId: "b" },
      { role: REVIEWER, scope: "table", scopeId: "t" },
    ];
    expect(can(bindings, "rows.write", "table", "t", "b")).toBe(true);
    expect(can(bindings, "rows.lock", "table", "t", "b")).toBe(true);
    expect(can(bindings, "rows.lock", "table", "other", "b")).toBe(false);
    expect(effectiveTableRole(bindings, "t", "b")).toEqual({
      role: "editor",
      shipped: [],
      made: [{ id: REVIEWER.id, name: REVIEWER.name }],
      permissions: PERMISSIONS.filter(
        (permission) =>
          roleGrants("editor", permission) || permission === "rows.lock",
      ),
    });
  });

  it("are given only by someone who holds all they give", () => {
    expect(mayGive("owner", "owner")).toBe(true);
    expect(mayGive("owner", REVIEWER)).toBe(true);
    expect(mayGive(STEWARD, "owner")).toBe(false);
    expect(mayGive(STEWARD, REVIEWER)).toBe(false);
    expect(
      mayGive(STEWARD, { id: "x", name: "x", permissions: ["rows.read"] }),
    ).toBe(true);
    expect(mayGive("editor", "viewer")).toBe(false);
    expect(mayGive(null, "viewer")).toBe(false);
    // A viewer reaches by a token: a made role that does not, gives none.
    const keeper: MadeRole = {
      id: "made-3",
      name: "Keeper",
      permissions: ["rows.read", "data.export", "members.manage"],
    };
    expect(mayGive(keeper, "viewer")).toBe(false);
    expect(
      mayGive(
        { ...keeper, permissions: [...keeper.permissions, "api.access"] },
        "viewer",
      ),
    ).toBe(true);
  });

  it("leave a read-only token a viewer's part of them", () => {
    expect(readOnlyGiven("owner")).toBe("viewer");
    expect(readOnlyGiven(REVIEWER)).toEqual({
      ...REVIEWER,
      permissions: ["rows.read"],
    });
  });

  it("act through a token only when they give it a way in", () => {
    for (const role of RANKED) expect(tokenGiven(role)).toBe(true);
    // The three beyond the rank take nothing out, by a token neither.
    for (const role of ["reader", "contributor", "validator"] as const) {
      expect(tokenGiven(role)).toBe(false);
    }
    // Read in the application, never through a token.
    expect(tokenGiven(REVIEWER)).toBe(false);
    expect(
      tokenGiven({
        ...REVIEWER,
        permissions: [...REVIEWER.permissions, "api.access"],
      }),
    ).toBe(true);
  });

  it("read rows, and hold only the catalogue's permissions", () => {
    expect(madePermissions(["rows.lock", "rows.read"])).toEqual([
      "rows.read",
      "rows.lock",
    ]);
    expect(madePermissions(["rows.write"])).toBeNull();
    expect(madePermissions(["rows.read", "admin"])).toBeNull();
  });

  it("ask a second factor of whoever they let give access or run a base", () => {
    const gate = (role: Binding["role"]) =>
      enrollmentGate({
        bindings: [{ role, scope: "base", scopeId: "b" }],
        factors: 0,
        isAdmin: false,
        scope: "owners",
      });
    expect(gate(STEWARD)).toBe("enroll");
    expect(gate(REVIEWER)).toBe("ok");
  });
});

describe("what each caller of Administration holds", () => {
  it("gives an administrator every permission, and support the helpdesk", () => {
    const admin = instanceCallers({
      isAdmin: true,
      isSupport: false,
      isAuditor: false,
      instanceRoles: [],
    });
    expect(callersPermissions(admin)).toEqual([...INSTANCE_PERMISSIONS]);
    expect(callersHold(["support"], "accounts.help")).toBe(true);
    expect(callersHold(["account_manager"], "groups.manage")).toBe(true);
    expect(callersHold(["source_manager"], "sources.browse")).toBe(true);
  });

  it("gives nobody else what gives access, the settings or the whole account", () => {
    const parts = [
      "support",
      "auditor",
      "account_manager",
      "source_manager",
    ] as const;
    for (const permission of [
      "access.grant",
      "accounts.control",
      "settings.manage",
      "roles.manage",
    ] as const) {
      expect(callersHold(parts, permission), permission).toBe(false);
    }
    expect(
      instanceCallers({
        isAdmin: false,
        isSupport: false,
        isAuditor: false,
        instanceRoles: [],
      }),
    ).toEqual([]);
  });
});

describe("tableRules", () => {
  const mine: FilterGroup = {
    conjunction: "and",
    conditions: [{ column: "owner", op: "is", value: "me" }],
  };
  const theirs: FilterGroup = {
    conjunction: "and",
    conditions: [{ column: "team", op: "is", value: "north" }],
  };

  it("says nothing when no attribution that reaches the table narrows", () => {
    const bindings: Binding[] = [
      { role: "editor", scope: "base", scopeId: "b" },
      { role: "viewer", scope: "table", scopeId: "other", rows: mine },
    ];
    expect(tableRules(bindings, "t", "b")).toBeUndefined();
  });

  it("narrows only the attribution a rule comes with", () => {
    // A base's viewer, and the table's editor of their own rows.
    const bindings: Binding[] = [
      { role: "viewer", scope: "base", scopeId: "b" },
      {
        role: "editor",
        scope: "table",
        scopeId: "t",
        rows: mine,
        fields: { amount: "write", secret: "hide" },
      },
    ];
    const rules = tableRules(bindings, "t", "b");
    expect(rules?.rows("rows.read")).toBeUndefined();
    expect(rules?.rows("rows.write")).toEqual(mine);
    expect(rules?.access("amount")).toBe("write");
    // The base's viewer reads every field, the rule's hidden one too.
    expect(rules?.access("secret")).toBe("read");
    expect(rules?.access("notes")).toBe("read");
  });

  it("joins the rows of several by OR, and reaches none without a giver", () => {
    const bindings: Binding[] = [
      { role: "editor", scope: "table", scopeId: "t", rows: mine },
      { role: "viewer", scope: "table", scopeId: "t", rows: theirs },
    ];
    const rules = tableRules(bindings, "t", "b");
    expect(rules?.rows("rows.read")).toEqual({
      conjunction: "or",
      conditions: [mine, theirs],
    });
    expect(rules?.rows("rows.write")).toEqual(mine);
    expect(rules?.rows("base.manage")).toEqual({
      conjunction: "or",
      conditions: [],
    });
  });

  it("never narrows who manages the table", () => {
    const bindings: Binding[] = [
      {
        role: "owner",
        scope: "table",
        scopeId: "t",
        rows: mine,
        fields: { amount: "hide" },
      },
    ];
    expect(tableRules(bindings, "t", "b")).toBeUndefined();
  });

  it("never gives a field above what its role gives", () => {
    const bindings: Binding[] = [
      {
        role: "viewer",
        scope: "table",
        scopeId: "t",
        fields: { amount: "write" },
      },
    ];
    const rules = tableRules(bindings, "t", undefined);
    expect(rules?.access("amount")).toBe("read");
    expect(rules?.access("notes")).toBe("hide");
  });
});

describe("the three shipped roles beyond the rank", () => {
  it("give what each is for, and nothing taken out of the base", () => {
    expect(rolePermissions("reader")).toEqual(["rows.read", "rows.comment"]);
    expect(rolePermissions("validator")).toEqual([
      "rows.read",
      "rows.comment",
      "rows.transition",
    ]);
    expect(rolePermissions("contributor")).toEqual([
      "rows.read",
      "rows.comment",
      "rows.write",
      "rows.delete",
      "rows.transition",
      "data.import",
    ]);
    for (const role of ["reader", "contributor", "validator"] as const) {
      expect(roleGrants(role, "data.export")).toBe(false);
      expect(roleGrants(role, "publish")).toBe(false);
    }
  });

  it("are named alone when the others add nothing, together otherwise", () => {
    const on = (...roles: Role[]): Binding[] =>
      roles.map((role) => ({ role, scope: "base", scopeId: "b" }));
    expect(roleFor(on("validator", "reader"), "base", "b")).toBe("validator");
    expect(roleFor(on("contributor", "validator"), "base", "b")).toBe(
      "contributor",
    );
    // An editor gives all a contributor does.
    expect(roleFor(on("editor", "contributor"), "base", "b")).toBe("editor");
    // A viewer exports; a validator takes steps: both, as two.
    expect(roleFor(on("viewer", "validator"), "base", "b")).toEqual({
      role: "viewer",
      shipped: ["validator"],
      made: [],
      permissions: PERMISSIONS.filter(
        (permission) =>
          roleGrants("viewer", permission) ||
          roleGrants("validator", permission),
      ),
    });
    expect(roleFor(on("owner", "validator"), "base", "b")).toBe("owner");
  });
});
