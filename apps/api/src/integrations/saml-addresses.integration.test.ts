/**
 * Whether a SAML sign-in reaches an account by its address: only when an
 * administrator said the provider verifies addresses (ADR 0111).
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userForIdentity } from "../auth/sso.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { issueAuthority } from "../tls/certificate.js";
import { clearSamlCache, resolveSaml, saveSaml } from "./saml.js";

const suffix = randomBytes(6).toString("hex");
const PUBLIC_URL = "https://grid.example.org";
const CERT = issueAuthority({
  commonName: "Test provider",
  names: ["idp.example.org"],
}).cert;

describe("a SAML provider's addresses", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  const input = {
    entryPoint: "https://idp.example.org/sso",
    issuer: "https://grid.example.org/saml",
  };
  const trusted = async () =>
    (await resolveSaml(db, { PUBLIC_URL })).config?.SAML_TRUST_ADDRESSES;
  const account = async (label: string) => {
    const email = `${label}-${suffix}@example.org`;
    const row = await db
      .insertInto("users")
      .values({ email, displayName: label })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { email, id: row.id };
  };
  const identity = (subject: string | null) => ({
    provider: "saml" as const,
    issuer: "https://idp.example.org",
    subject,
  });

  beforeAll(async () => {
    const created = await createTestDatabase("saml_addresses");
    db = created.db;
    close = created.close;
    admin = (await account("admin")).id;
    await writeSettings(db, admin, { signup: "open" });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("is off for a new provider, and a save that omits it keeps it", async () => {
    await saveSaml(db, admin, { ...input, idpCert: CERT }, PUBLIC_URL);
    expect(await trusted()).toBe(false);
    await saveSaml(db, admin, { ...input, trustsAddresses: true }, PUBLIC_URL);
    clearSamlCache(db);
    expect(await trusted()).toBe(true);
    await saveSaml(db, admin, input, PUBLIC_URL);
    clearSamlCache(db);
    expect(await trusted()).toBe(true);
    await saveSaml(db, admin, { ...input, trustsAddresses: false }, PUBLIC_URL);
    clearSamlCache(db);
    expect(await trusted()).toBe(false);
  });

  it("does not let an untrusted address reach an account that exists", async () => {
    const victim = await account("victim");
    await expect(
      userForIdentity(
        db,
        identity(`s-${suffix}`),
        victim.email,
        "Someone",
        undefined,
        {
          linkExisting: false,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    const bound = await db
      .selectFrom("ssoIdentities")
      .select("userId")
      .where("userId", "=", victim.id)
      .execute();
    expect(bound).toEqual([]);
  });

  it("binds the account when the provider is trusted, and the binding lasts", async () => {
    const person = await account("person");
    const subject = `bound-${suffix}`;
    expect(
      await userForIdentity(
        db,
        identity(subject),
        person.email,
        "Person",
        undefined,
        {
          linkExisting: true,
        },
      ),
    ).toBe(person.id);
    expect(
      await userForIdentity(
        db,
        identity(subject),
        person.email,
        "Person",
        undefined,
        {
          linkExisting: false,
        },
      ),
    ).toBe(person.id);
  });

  it("still makes a new account for a new address", async () => {
    const email = `new-${suffix}@example.org`;
    const id = await userForIdentity(
      db,
      identity(`n-${suffix}`),
      email,
      "New",
      undefined,
      {
        linkExisting: false,
      },
    );
    const row = await db
      .selectFrom("users")
      .select("email")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.email).toBe(email);
  });
});
