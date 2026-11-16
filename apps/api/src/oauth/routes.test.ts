import { describe, expect, it } from "vitest";
import { authorizationServerMetadata, clientProof } from "./routes.js";

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

describe("clientProof", () => {
  it("reads the client from the form when no header is sent", () => {
    expect(
      clientProof(undefined, { client_id: "agc_a", client_secret: "ags_b" }),
    ).toEqual({ clientId: "agc_a", clientSecret: "ags_b", header: false });
  });

  it("reads the client from a Basic header, its parts form-encoded", () => {
    expect(clientProof(basic("agc_a", "ags_b"), {})).toEqual({
      clientId: "agc_a",
      clientSecret: "ags_b",
      header: true,
    });
    expect(clientProof(basic("a%3Ab", "s+p%2B"), {})).toMatchObject({
      clientId: "a:b",
      clientSecret: "s p+",
    });
  });

  it("refuses a secret sent twice, and a header it cannot read", () => {
    expect(clientProof(basic("agc_a", "ags_b"), { client_secret: "x" })).toBe(
      "twice",
    );
    expect(clientProof("Bearer ag_token", {})).toBe("unreadable");
    expect(clientProof("Basic", {})).toBe("unreadable");
    expect(
      clientProof(`Basic ${Buffer.from("nocolon").toString("base64")}`, {}),
    ).toBe("unreadable");
    expect(clientProof(basic("agc_a", "100%"), {})).toBe("unreadable");
  });
});

describe("authorizationServerMetadata", () => {
  it("names the grant's addresses on the address people open", () => {
    expect(authorizationServerMetadata("https://grid.example.org/")).toEqual({
      issuer: "https://grid.example.org",
      authorization_endpoint: "https://grid.example.org/oauth/authorize",
      token_endpoint: "https://grid.example.org/oauth/token",
      revocation_endpoint: "https://grid.example.org/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      revocation_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
    });
  });
});
