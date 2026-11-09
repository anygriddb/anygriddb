import { describe, expect, it } from "vitest";
import {
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
        userName: "ada@corp.onmicrosoft.com",
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
      userName: "ada@corp.onmicrosoft.com",
      email: "ada@corp.example",
      displayName: "Ada Lovelace",
      externalId: "e-1",
      active: true,
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
    expect(scimDisplayName("José O’Neil", "j@x.y")).toBe("José O Neil");
    expect(scimDisplayName("  ", "jean.dupont@x.y")).toBe("jean.dupont");
    expect(scimDisplayName("***", "***@x.y")).toBe("Utilisateur");
  });
});

describe("patchScimUser", () => {
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
      displayName: "Augusta",
      email: "augusta@corp.example",
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
