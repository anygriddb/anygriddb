import { describe, expect, it } from "vitest";
import {
  backupCodesFile,
  proofNeeded,
  totpAction,
} from "./second-factor-model";

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

describe("proofNeeded", () => {
  it("asks nothing for a first authenticator", () => {
    expect(proofNeeded("totp", { methods: [], hasPassword: true })).toBeNull();
    expect(
      proofNeeded("totp", { methods: ["webauthn"], hasPassword: true }),
    ).toBeNull();
  });

  it("asks the password, or else the current code, for a replacement", () => {
    expect(proofNeeded("totp", { methods: ["totp"], hasPassword: true })).toBe(
      "password",
    );
    expect(proofNeeded("totp", { methods: ["totp"], hasPassword: false })).toBe(
      "code",
    );
  });

  it("asks a proof for a passkey whenever the account has one to give", () => {
    expect(proofNeeded("passkey", { methods: [], hasPassword: true })).toBe(
      "password",
    );
    expect(
      proofNeeded("passkey", { methods: ["totp"], hasPassword: false }),
    ).toBe("code");
    // An account from a provider, with no factor yet: nothing to prove with.
    expect(
      proofNeeded("passkey", { methods: [], hasPassword: false }),
    ).toBeNull();
  });

  it("asks nothing for a code by email as a first factor, and a proof beside another", () => {
    expect(proofNeeded("email", { methods: [], hasPassword: true })).toBeNull();
    expect(
      proofNeeded("email", { methods: [], hasPassword: false }),
    ).toBeNull();
    // Beside an authenticator or a passkey, it is one more way in.
    expect(proofNeeded("email", { methods: ["totp"], hasPassword: true })).toBe(
      "password",
    );
    expect(
      proofNeeded("email", { methods: ["totp"], hasPassword: false }),
    ).toBe("code");
    expect(
      proofNeeded("email", { methods: ["webauthn"], hasPassword: true }),
    ).toBe("password");
  });

  it("asks a proof to turn a code by email off, when there is one to give", () => {
    expect(
      proofNeeded("email_off", { methods: ["email"], hasPassword: true }),
    ).toBe("password");
    expect(
      proofNeeded("email_off", {
        methods: ["email", "totp"],
        hasPassword: false,
      }),
    ).toBe("code");
    expect(
      proofNeeded("email_off", { methods: ["email"], hasPassword: false }),
    ).toBeNull();
  });
});

describe("backupCodesFile", () => {
  it("writes one code per line under the instance and the day", () => {
    expect(
      backupCodesFile(["AAAA", "BBBB"], "grid.example.org", "2026-11-13"),
    ).toBe("AnyGridDB — grid.example.org\n2026-11-13\n\nAAAA\nBBBB\n");
  });
});
