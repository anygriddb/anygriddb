import { describe, expect, it } from "vitest";
import { apiRequest } from "./api-console";

const TABLE = "11111111-1111-4111-8111-111111111111";

describe("apiRequest", () => {
  it("builds each operation's verb, path, and body", () => {
    const input = { query: "?limit=5", recordId: " 7 ", body: "{}" };
    expect(apiRequest(TABLE, "list", input)).toEqual({
      verb: "GET",
      path: `/api/v1/tables/${TABLE}/records?limit=5`,
    });
    expect(apiRequest(TABLE, "get", input).path).toBe(
      `/api/v1/tables/${TABLE}/records/7`,
    );
    expect(apiRequest(TABLE, "update", input)).toEqual({
      verb: "PATCH",
      path: `/api/v1/tables/${TABLE}/records`,
      body: "{}",
    });
    expect(apiRequest(TABLE, "delete", input).path).toBe(
      `/api/v1/tables/${TABLE}/records?records=7`,
    );
  });

  it("keeps a client's key inside its path segment", () => {
    const input = { query: "", recordId: '{"k0":"a/b"}', body: "" };
    const { path } = apiRequest(TABLE, "get", input);
    expect(path).not.toContain("a/b");
    expect(path.endsWith(encodeURIComponent('{"k0":"a/b"}'))).toBe(true);
    expect(apiRequest(TABLE, "list", input).path).toBe(
      `/api/v1/tables/${TABLE}/records`,
    );
  });
});
