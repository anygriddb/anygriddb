import { describe, expect, it } from "vitest";
import { stableNameId } from "./sso.js";

const FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format";

describe("stableNameId", () => {
  it("keeps a persistent NameID as the subject", () => {
    expect(stableNameId("a7f3c2", `${FORMAT}:persistent`)).toBe("a7f3c2");
  });

  it("drops a NameID that says nothing lasting", () => {
    expect(stableNameId("x1y2", `${FORMAT}:transient`)).toBeNull();
    expect(
      stableNameId(
        "ada@example.com",
        "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      ),
    ).toBeNull();
    expect(stableNameId("ada", undefined)).toBeNull();
    expect(stableNameId(undefined, `${FORMAT}:persistent`)).toBeNull();
  });
});
