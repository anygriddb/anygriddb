import { describe, expect, it } from "vitest";
import { totpAction } from "./second-factor-model";

describe("totpAction", () => {
  it("offers enable when no authenticator is enrolled", () => {
    expect(totpAction([])).toBe("enable");
    expect(totpAction(["webauthn"])).toBe("enable");
  });

  it("offers replace when TOTP is already enrolled", () => {
    expect(totpAction(["totp"])).toBe("replace");
    expect(totpAction(["totp", "webauthn"])).toBe("replace");
  });
});
