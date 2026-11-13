import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./access.js", () => ({
  factorMethods: vi.fn(),
}));

vi.mock("./argon2.js", () => ({
  verifyPassword: vi.fn(
    async (_hash: string, password: string) => password === "right",
  ),
}));

vi.mock("./totp.js", () => ({
  consumeTotpCode: vi.fn(
    async (_db: unknown, _id: string, code: string) => code === "111111",
  ),
}));

vi.mock("./backup-store.js", () => ({
  consumeBackupCode: vi.fn(async () => false),
}));

import { keyRing } from "./key-ring.js";
import { factorMethods } from "./access.js";
import { FRESH_STEP_UP_MS, proveStepUp } from "./step-up.js";

const key = keyRing(Buffer.alloc(32, 7));

function dbWithPassword(hasPassword: boolean) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () =>
            hasPassword ? { hash: "argon" } : undefined,
        }),
      }),
    }),
  } as never;
}

describe("proveStepUp", () => {
  beforeEach(() => {
    vi.mocked(factorMethods).mockReset();
  });

  it("accepts the password when the account has one", async () => {
    vi.mocked(factorMethods).mockResolvedValue([]);
    expect(
      await proveStepUp(dbWithPassword(true), key, {
        userId: "u",
        startedAt: new Date(),
        proof: { password: "right" },
      }),
    ).toBe("ok");
  });

  it("rejects a missing proof", async () => {
    vi.mocked(factorMethods).mockResolvedValue(["totp"]);
    expect(
      await proveStepUp(dbWithPassword(true), key, {
        userId: "u",
        startedAt: new Date(),
        proof: {},
      }),
    ).toBe("missing");
  });

  it("accepts a TOTP code for an SSO-only account with an authenticator", async () => {
    vi.mocked(factorMethods).mockResolvedValue(["totp"]);
    expect(
      await proveStepUp(dbWithPassword(false), key, {
        userId: "u",
        startedAt: new Date(),
        proof: { factorCode: "111111" },
      }),
    ).toBe("ok");
  });

  it("asks a fresh sign-in for a passkey-only SSO account when stale", async () => {
    vi.mocked(factorMethods).mockResolvedValue(["webauthn"]);
    const startedAt = new Date(Date.now() - FRESH_STEP_UP_MS - 1_000);
    expect(
      await proveStepUp(dbWithPassword(false), key, {
        userId: "u",
        startedAt,
        proof: {},
      }),
    ).toBe("stale");
  });

  it("accepts a fresh sign-in for a passkey-only SSO account", async () => {
    vi.mocked(factorMethods).mockResolvedValue(["webauthn"]);
    expect(
      await proveStepUp(dbWithPassword(false), key, {
        userId: "u",
        startedAt: new Date(),
        proof: {},
      }),
    ).toBe("ok");
  });
});
