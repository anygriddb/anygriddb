import { describe, expect, it } from "vitest";
import {
  ARGON2_OPTIONS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./argon2.js";

/** Written by the `argon2` package this module used before @node-rs/argon2. */
const LEGACY_HASH =
  "$argon2id$v=19$m=65536,p=1,t=3$5rPXX+I+bXpY+4/U5xszqg$b/tQ6LQjfDaEJe/cwCxS3GKZ5pI1uy/+yU/LB49ooMQ";

describe("argon2id", () => {
  it("uses 64 MiB and verifies a password", async () => {
    expect(ARGON2_OPTIONS.memoryCost).toBe(65_536);
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(
      true,
    );
    expect(await verifyPassword(hash, "wrong")).toBe(false);
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, "wrong")).resolves.toBe(
      false,
    );
  });

  it("still verifies hashes stored before the library change", async () => {
    expect(
      await verifyPassword(LEGACY_HASH, "legacy password from node-argon2"),
    ).toBe(true);
    expect(await verifyPassword(LEGACY_HASH, "wrong")).toBe(false);
  });
});
