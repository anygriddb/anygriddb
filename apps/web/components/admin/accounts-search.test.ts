import { describe, expect, it } from "vitest";
import {
  accountsSearchSchema,
  filtered,
  nextSearch,
  sortSearch,
  usersQuery,
} from "./accounts-search";

describe("the accounts list's address", () => {
  it("keeps what it knows and drops anything else", () => {
    expect(
      accountsSearchSchema.parse({
        q: "  ada ",
        status: "locked",
        admin: "maybe",
        mfa: "no",
        origin: "ldap",
        sort: "lastSeen",
        dir: "sideways",
        page: "3",
      }),
    ).toEqual({
      q: "ada",
      status: "locked",
      mfa: "no",
      sort: "lastSeen",
      page: 3,
    });
    expect(accountsSearchSchema.parse({ page: "1" })).toEqual({});
    expect(accountsSearchSchema.parse({ page: "-4" })).toEqual({});
    expect(accountsSearchSchema.parse({ q: "x".repeat(101) })).toEqual({});
  });

  it("asks the server for the filters, sort, and page", () => {
    expect(usersQuery({})).toEqual({
      search: undefined,
      status: undefined,
      admin: undefined,
      mfa: undefined,
      origin: undefined,
      sort: "created",
      direction: "asc",
      offset: 0,
      limit: 50,
    });
    expect(
      usersQuery({ q: "ada", admin: "yes", mfa: "no", dir: "desc", page: 3 }),
    ).toMatchObject({
      search: "ada",
      admin: true,
      mfa: false,
      direction: "desc",
      offset: 100,
    });
  });

  it("goes back to the first page when a filter changes, and leaves defaults out", () => {
    expect(nextSearch({ q: "ada", page: 4 }, { status: "disabled" })).toEqual({
      q: "ada",
      status: "disabled",
    });
    expect(nextSearch({ q: "ada" }, { q: "" })).toEqual({});
    expect(nextSearch({ status: "active" }, { page: 2 })).toEqual({
      status: "active",
      page: 2,
    });
    expect(nextSearch({ page: 2 }, { page: 1 })).toEqual({});
  });

  it("sorts by a column, then turns the order round", () => {
    expect(sortSearch({}, "name")).toEqual({ sort: "name" });
    expect(sortSearch({ sort: "name" }, "name")).toEqual({
      sort: "name",
      dir: "desc",
    });
    expect(sortSearch({ sort: "name", dir: "desc" }, "name")).toEqual({
      sort: "name",
    });
    expect(sortSearch({}, "created")).toEqual({ dir: "desc" });
    expect(sortSearch({ sort: "name", dir: "desc", page: 3 }, "email")).toEqual(
      { sort: "email" },
    );
  });

  it("knows when the list is narrowed", () => {
    expect(filtered({ sort: "name", page: 2 })).toBe(false);
    expect(filtered({ origin: "scim" })).toBe(true);
  });
});
