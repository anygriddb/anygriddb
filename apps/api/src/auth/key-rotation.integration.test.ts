/**
 * The encryption key changed (ADR 0066), against the real tables: what
 * an earlier key sealed, and what was sealed before keys had identifiers,
 * is sealed again under the current key, and the earlier key can go.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { resealTlsKey } from "../tls/authority.js";
import { consumeBackupCode, replaceBackupCodes } from "./backup-store.js";
import { generateBackupCode, hashBackupCode } from "./backup-code.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { keyRing, parseKeyRing } from "./key-ring.js";
import { BEFORE_KEY_IDS, rotateKeys } from "./key-rotation.js";
import { readTotpSecret, saveTotpSecret } from "./totp.js";

const suffix = randomBytes(6).toString("hex");

/** A value as every release before key identifiers sealed it. */
function sealedBeforeIds(plaintext: string, master: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, nonce);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

describe("the encryption key changed", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let tlsDir = "";
  let ada = "";
  let bob = "";
  let hookId = "";
  let adaCode = "";
  const oldMaster = randomBytes(32);
  const newMaster = randomBytes(32);
  const before = keyRing(oldMaster);
  const during = parseKeyRing(
    `next:${newMaster.toString("base64")}`,
    `0:${oldMaster.toString("base64")}`,
  );
  const after = keyRing(newMaster, "next");

  beforeAll(async () => {
    const created = await createTestDatabase("key_rotation");
    db = created.db;
    close = created.close;
    tlsDir = await mkdtemp(join(tmpdir(), "anygriddb-keys-"));
    const people = await db
      .insertInto("users")
      .values([
        { email: `ada-${suffix}@example.org`, displayName: "Ada" },
        { email: `bob-${suffix}@example.org`, displayName: "Bob" },
      ])
      .returning("id")
      .execute();
    ada = people[0]?.id ?? "";
    bob = people[1]?.id ?? "";

    // Ada's second factor, sealed by the release before this one; Bob's,
    // by this one under the first key.
    const old = sealedBeforeIds("JBSWY3DPEHPK3PXP", oldMaster);
    await db
      .insertInto("totpSecrets")
      .values({ userId: ada, ...old, confirmedAt: new Date(), lastStep: 1 })
      .execute();
    await saveTotpSecret(db, bob, "GEZDGNBVGY3TQOJQ", before, 1);

    // Mail without a password: there is nothing sealed to rewrite.
    await db
      .insertInto("instanceSmtp")
      .values({ host: "mail.example.org", fromAddress: "grid@example.org" })
      .execute();
    const siem = sealedBeforeIds("siem-secret", oldMaster);
    await db
      .insertInto("instanceSiem")
      .values({
        url: "https://siem.example.org/in",
        secretCiphertext: siem.ciphertext,
        secretNonce: siem.nonce,
      })
      .execute();

    const baseId = (await insertBase(db, ada, { name: "Keys" })).id;
    const tableId = (
      await insertTable(db, ada, {
        baseId,
        name: "Tasks",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    const secret = encryptSecret("hook-secret", before, "webhook");
    const headers = sealedBeforeIds('{"x-token":"abc"}', oldMaster);
    hookId = (
      await db
        .insertInto("webhooks")
        .values({
          tableId,
          kind: "http",
          target: "https://hooks.example.org/in",
          secretCiphertext: secret.ciphertext,
          secretNonce: secret.nonce,
          headersCiphertext: headers.ciphertext,
          headersNonce: headers.nonce,
          events: ["insert"],
          createdBy: ada,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

    const tls = sealedBeforeIds("-----BEGIN PRIVATE KEY-----", oldMaster);
    await writeFile(
      join(tlsDir, "internal.key.enc"),
      JSON.stringify({
        nonce: tls.nonce.toString("base64"),
        ciphertext: tls.ciphertext.toString("base64"),
      }),
    );

    adaCode = generateBackupCode();
    await replaceBackupCodes(db, ada, [hashBackupCode(adaCode, before)]);
  }, 120_000);

  afterAll(async () => {
    await rm(tlsDir, { recursive: true, force: true });
    await close?.();
  });

  it("counts what each key holds, and changes nothing when only asked", async () => {
    const report = await rotateKeys(db, during, { write: false, tlsDir });
    expect(report).toEqual({
      // Ada's factor, the collector's secret, the hook's headers, the
      // private key; then Bob's factor and the hook's secret.
      byKey: { [BEFORE_KEY_IDS]: 4, "0": 2 },
      rewritten: 0,
      unreadable: [],
      forbidden: [],
    });
    expect(await readTotpSecret(db, ada, before)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("names a key file of another account, and goes on with the rest", async () => {
    // As the internal authority's key is root's in the compose stack: a
    // file this account may not read. Root reads everything: nothing to
    // see when the tests run as root.
    if (process.getuid?.() === 0) return;
    const path = join(tlsDir, "internal.key.enc");
    await chmod(path, 0o000);
    try {
      const report = await rotateKeys(db, during, { write: false, tlsDir });
      expect(report.forbidden).toEqual(["internal.key.enc"]);
      expect(report.unreadable).toEqual([]);
      // What is in the database is still counted.
      expect(report.byKey).toEqual({ [BEFORE_KEY_IDS]: 3, "0": 2 });
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("names what no key opens, without the earlier key, and leaves it", async () => {
    const report = await rotateKeys(db, after, { write: true, tlsDir });
    expect(report.rewritten).toBe(0);
    expect(report.byKey).toEqual({});
    expect(report.unreadable).toHaveLength(6);
    expect(report.unreadable).toContain(`totp_secrets.ciphertext ${ada}`);
    expect(report.unreadable).toContain(
      `webhooks.headers_ciphertext ${hookId}`,
    );
    expect(report.unreadable).toContain(
      "internal.key.enc in the certificates folder",
    );
    expect(await readTotpSecret(db, ada, before)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("seals everything again under the current key, once", async () => {
    const report = await rotateKeys(db, during, { write: true, tlsDir });
    expect(report).toEqual({
      byKey: { next: 6 },
      rewritten: 6,
      unreadable: [],
      forbidden: [],
    });
    // The earlier key can go: the new one alone opens everything.
    expect(await readTotpSecret(db, ada, after)).toBe("JBSWY3DPEHPK3PXP");
    expect(await readTotpSecret(db, bob, after)).toBe("GEZDGNBVGY3TQOJQ");
    const hook = await db
      .selectFrom("webhooks")
      .selectAll()
      .where("id", "=", hookId)
      .executeTakeFirstOrThrow();
    expect(
      decryptSecret(hook.secretCiphertext, hook.secretNonce, after, "webhook"),
    ).toBe("hook-secret");
    expect(
      decryptSecret(
        hook.headersCiphertext ?? Buffer.alloc(0),
        hook.headersNonce ?? Buffer.alloc(0),
        after,
        "webhook",
      ),
    ).toBe('{"x-token":"abc"}');
    const siem = await db
      .selectFrom("instanceSiem")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(
      decryptSecret(siem.secretCiphertext, siem.secretNonce, after, "siem"),
    ).toBe("siem-secret");
    expect(
      await resealTlsKey(tlsDir, "internal.key.enc", after, false),
    ).toEqual({ keyId: "next", rewritten: false });
    expect(
      JSON.parse(await readFile(join(tlsDir, "internal.key.enc"), "utf8")),
    ).toHaveProperty("ciphertext");

    // A second run finds nothing left to do.
    expect(await rotateKeys(db, during, { write: true, tlsDir })).toEqual({
      byKey: { next: 6 },
      rewritten: 0,
      unreadable: [],
      forbidden: [],
    });
  });

  it("keeps a backup code made before the change, while its key is kept", async () => {
    // Without the earlier key the code is unknown, and is not spent.
    expect(await consumeBackupCode(db, ada, adaCode, after)).toBe(false);
    expect(await consumeBackupCode(db, ada, adaCode, during)).toBe(true);
    expect(await consumeBackupCode(db, ada, adaCode, during)).toBe(false);
  });
});
