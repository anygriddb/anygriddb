import { describe, expect, it } from "vitest";
import {
  NO_ENTERPRISE,
  parseScimFilter,
  parseScimGroup,
  parseScimPatch,
  parseScimUser,
  patchScimGroup,
  patchScimUser,
  SCIM_PATCH,
  ScimError,
  scimDisplayName,
  scimPage,
  scimSchemas,
  scimUserResource,
  type ScimUserState,
} from "./scim";

const patch = (...Operations: unknown[]) =>
  parseScimPatch({ schemas: [SCIM_PATCH], Operations });

const ada: ScimUserState = {
  userName: "ada@corp.example",
  email: "ada@corp.example",
  displayName: "Ada Lovelace",
  externalId: "00u1",
  active: true,
  givenName: "Ada",
  familyName: "Lovelace",
  enterprise: NO_ENTERPRISE,
};

const scimType = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ScimError)
      return `${String(error.status)} ${error.scimType ?? ""}`;
    throw error;
  }
  return "no error";
};

describe("parseScimFilter", () => {
  it("reads the filters providers send before creating", () => {
    expect(parseScimFilter("user", 'userName eq "ada@corp.example"')).toEqual({
      attribute: "userName",
      value: "ada@corp.example",
    });
    expect(
      parseScimFilter("user", 'emails[type eq "work"].value eq "a@b.c"'),
    ).toEqual({
      attribute: "email",
      value: "a@b.c",
    });
    expect(parseScimFilter("user", 'EXTERNALID EQ "x\\"y"')).toEqual({
      attribute: "externalId",
      value: 'x"y',
    });
    expect(parseScimFilter("group", 'displayName eq "Ventes"')).toEqual({
      attribute: "displayName",
      value: "Ventes",
    });
    expect(parseScimFilter("user", undefined)).toBeNull();
  });

  it("refuses what it cannot answer exactly", () => {
    expect(scimType(() => parseScimFilter("user", 'userName sw "a"'))).toBe(
      "400 invalidFilter",
    );
    expect(scimType(() => parseScimFilter("user", 'title eq "x"'))).toBe(
      "400 invalidFilter",
    );
    expect(
      scimType(() =>
        parseScimFilter("user", 'userName eq "a" and active eq true'),
      ),
    ).toBe("400 invalidFilter");
  });
});

describe("scimPage", () => {
  it("counts from 1 and caps the page", () => {
    expect(scimPage({})).toEqual({ offset: 0, limit: 100, startIndex: 1 });
    expect(scimPage({ startIndex: "11", count: "5000" })).toEqual({
      offset: 10,
      limit: 200,
      startIndex: 11,
    });
    expect(scimPage({ startIndex: "0", count: "0" })).toEqual({
      offset: 0,
      limit: 0,
      startIndex: 1,
    });
  });
});

describe("parseScimUser", () => {
  it("takes the primary email, and keeps a user name that is not one", () => {
    expect(
      parseScimUser({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "ada@directory.example",
        externalId: "e-1",
        name: { givenName: "Ada", familyName: "Lovelace" },
        emails: [
          { value: "old@corp.example", type: "other" },
          { value: "Ada@Corp.Example", type: "work", primary: true },
        ],
        active: "True",
        title: "Engineer",
      }),
    ).toEqual({
      userName: "ada@directory.example",
      email: "ada@corp.example",
      displayName: "Ada Lovelace",
      externalId: "e-1",
      active: true,
      givenName: "Ada",
      familyName: "Lovelace",
      enterprise: NO_ENTERPRISE,
    });
  });

  it("falls back to the user name as email, and refuses an account without one", () => {
    expect(parseScimUser({ userName: "bob@corp.example" })).toMatchObject({
      email: "bob@corp.example",
      displayName: "bob",
      active: true,
    });
    expect(scimType(() => parseScimUser({ userName: "bob" }))).toBe(
      "400 invalidValue",
    );
    expect(scimType(() => parseScimUser({ emails: [] }))).toBe(
      "400 invalidSyntax",
    );
  });

  it("makes a display name AnyGridDB accepts", () => {
    // A name keeps its own signs, the apostrophe people type among them.
    expect(scimDisplayName("José O’Neil", "j@x.y")).toBe("José O’Neil");
    expect(scimDisplayName("Ada\tLovelace\n", "a@x.y")).toBe("Ada Lovelace");
    expect(scimDisplayName("  ", "jean.dupont@x.y")).toBe("jean.dupont");
    expect(scimDisplayName("***", "***@x.y")).toBe("Account");
    expect(scimDisplayName("***", "***@x.y", "Compte")).toBe("Compte");
  });
});

describe("patchScimUser", () => {
  it("keeps the part of a name a provider did not send", () => {
    const family = patchScimUser(
      ada,
      patch({ op: "replace", path: "name.familyName", value: "King" }),
    );
    expect(family).toMatchObject({
      displayName: "Ada King",
      givenName: "Ada",
      familyName: "King",
    });
    const removed = patchScimUser(
      ada,
      patch({ op: "remove", path: "name.familyName" }),
    );
    expect(removed).toMatchObject({ displayName: "Ada", familyName: null });
  });

  it("finds the parts of a name kept before they were", () => {
    const before = { ...ada, givenName: null, familyName: null };
    expect(
      patchScimUser(
        { ...before, displayName: "Anne Marie Martin" },
        patch({ op: "replace", path: "name.givenName", value: "Anna" }),
      ),
    ).toMatchObject({
      displayName: "Anna Martin",
      givenName: "Anna",
      familyName: "Martin",
    });
    expect(
      patchScimUser(
        { ...before, displayName: "Cher" },
        patch({ op: "replace", path: "name.familyName", value: "Sarkisian" }),
      ),
    ).toMatchObject({ displayName: "Cher Sarkisian", givenName: "Cher" });
  });

  it("leaves the parts alone when only the display name changes", () => {
    expect(
      patchScimUser(
        ada,
        patch({ op: "replace", path: "displayName", value: "The Countess" }),
      ),
    ).toMatchObject({
      displayName: "The Countess",
      givenName: "Ada",
      familyName: "Lovelace",
    });
  });

  it("keeps a name's parts on one line, and to the length of a name", () => {
    const next = patchScimUser(
      ada,
      patch({
        op: "replace",
        path: "name.givenName",
        value: `A\nB${"c".repeat(200)}`,
      }),
    );
    expect(next.givenName).not.toContain("\n");
    expect(next.givenName?.length).toBeLessThanOrEqual(80);
  });

  it("applies what Entra ID sends: paths, text booleans, and no-path values", () => {
    expect(
      patchScimUser(
        ada,
        patch(
          { op: "Replace", path: "active", value: "False" },
          { op: "Replace", path: "name.givenName", value: "Augusta" },
          {
            op: "Add",
            path: 'emails[type eq "work"].value',
            value: "augusta@corp.example",
          },
          {
            op: "Replace",
            path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
            value: "R&D",
          },
          { op: "Remove", path: "title" },
        ),
      ),
    ).toEqual({
      ...ada,
      active: false,
      displayName: "Augusta Lovelace",
      givenName: "Augusta",
      email: "augusta@corp.example",
      // The enterprise extension's department is kept (ADR 0142).
      enterprise: { ...NO_ENTERPRISE, department: "R&D" },
    });
    expect(
      patchScimUser(
        ada,
        patch({
          op: "replace",
          value: { active: false, displayName: "Ada L." },
        }),
      ),
    ).toEqual({ ...ada, active: false, displayName: "Ada L." });
  });

  it("refuses to remove what an account needs, and bad values", () => {
    expect(
      scimType(() =>
        patchScimUser(ada, patch({ op: "remove", path: "userName" })),
      ),
    ).toBe("400 mutability");
    expect(
      scimType(() =>
        patchScimUser(
          ada,
          patch({ op: "replace", path: "active", value: "maybe" }),
        ),
      ),
    ).toBe("400 invalidValue");
    expect(
      scimType(() =>
        patchScimUser(
          ada,
          patch({ op: "replace", path: "emails", value: "nope" }),
        ),
      ),
    ).toBe("400 invalidValue");
    expect(
      scimType(() => parseScimPatch({ Operations: [{ op: "add" }] })),
    ).toBe("400 invalidSyntax");
  });
});

describe("groups", () => {
  const group = {
    displayName: "Ventes",
    externalId: null,
    members: ["u1", "u2"],
  };

  it("reads a group with its members once each", () => {
    expect(
      parseScimGroup({
        displayName: "Ventes",
        members: [{ value: "u1" }, { value: "u1" }],
      }),
    ).toEqual({ displayName: "Ventes", externalId: null, members: ["u1"] });
  });

  it("adds, removes, and replaces members as Okta and Entra ID send them", () => {
    expect(
      patchScimGroup(
        group,
        patch(
          { op: "add", path: "members", value: [{ value: "u3" }] },
          { op: "remove", path: 'members[value eq "u1"]' },
          { op: "Remove", path: "members", value: [{ value: "u2" }] },
          { op: "replace", value: { displayName: "Ventes Europe" } },
        ),
      ),
    ).toEqual({
      displayName: "Ventes Europe",
      externalId: null,
      members: ["u3"],
    });
    expect(
      patchScimGroup(
        group,
        patch({ op: "replace", path: "members", value: [{ value: "u9" }] }),
      ).members,
    ).toEqual(["u9"]);
    expect(
      patchScimGroup(group, patch({ op: "remove", path: "members" })).members,
    ).toEqual([]);
    expect(
      scimType(() =>
        patchScimGroup(group, patch({ op: "add", path: "owners", value: [] })),
      ),
    ).toBe("400 invalidPath");
  });
});

describe("SCIM's enterprise extension (ADR 0142)", () => {
  const ENTERPRISE =
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

  it("reads a user's department and division, and none where the body says none", () => {
    const user = parseScimUser({
      userName: "ada@corp.example",
      emails: [{ value: "ada@corp.example" }],
      [ENTERPRISE]: {
        department: "  Ward 3 ",
        division: "",
        manager: { value: "00u2" },
      },
    });
    expect(user.enterprise).toEqual({
      department: "Ward 3",
      division: null,
      organization: null,
      costCenter: null,
    });
  });

  it("patches a field by its path, by the extension whole, and takes one away", () => {
    const moved = patchScimUser(
      ada,
      patch(
        { op: "replace", path: `${ENTERPRISE}:department`, value: "Ward 4" },
        { op: "add", value: { [ENTERPRISE]: { costCenter: "CC-9" } } },
        { op: "Replace", path: `${ENTERPRISE}:employeeNumber`, value: "7" },
      ),
    );
    expect(moved.enterprise).toEqual({
      ...NO_ENTERPRISE,
      department: "Ward 4",
      costCenter: "CC-9",
    });
    expect(
      patchScimUser(
        moved,
        patch({ op: "remove", path: `${ENTERPRISE}:department` }),
      ).enterprise.department,
    ).toBeNull();
    expect(
      patchScimUser(moved, patch({ op: "remove", path: ENTERPRISE }))
        .enterprise,
    ).toEqual(NO_ENTERPRISE);
  });

  it("returns the fields it keeps, and announces the extension", () => {
    const resource = scimUserResource(
      {
        ...ada,
        enterprise: { ...NO_ENTERPRISE, department: "Ward 3" },
        id: "u1",
        created: new Date("2026-01-01T00:00:00Z"),
      },
      "https://grid.example.org/scim/v2",
    );
    expect(resource.schemas).toContain(ENTERPRISE);
    expect(resource).toMatchObject({ [ENTERPRISE]: { department: "Ward 3" } });
    const plain = scimUserResource(
      { ...ada, id: "u1", created: new Date("2026-01-01T00:00:00Z") },
      "https://grid.example.org/scim/v2",
    );
    expect(plain.schemas).not.toContain(ENTERPRISE);
    expect(
      scimSchemas("https://grid.example.org/scim/v2").map(
        (schema) => schema.id,
      ),
    ).toContain(ENTERPRISE);
  });
});
