import type { KeyRing } from "./key-ring.js";
import type { Database } from "@anygriddb/db";
import type { CacheItem, CacheProvider } from "@node-saml/node-saml";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { hashSessionToken } from "./session.js";

const REQUEST_KIND = "saml-request";
const REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * The AuthnRequest ids SAML must see again in `InResponseTo`. Stored in
 * the database so every API process shares them. A successful sign-in
 * removes the id; a replay no longer matches.
 */
export function samlRequestCache(db: Database, key: KeyRing): CacheProvider {
  return {
    async saveAsync(id: string, value: string): Promise<CacheItem> {
      const sealed = encryptSecret(value, key, "sso-state");
      await db
        .insertInto("oauthStates")
        .values({
          stateHash: hashSessionToken(id),
          kind: REQUEST_KIND,
          verifierCiphertext: sealed.ciphertext,
          verifierNonce: sealed.nonce,
          expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
        })
        .execute();
      return { value, createdAt: Date.now() };
    },
    async getAsync(id: string): Promise<string | null> {
      const row = await db
        .selectFrom("oauthStates")
        .select(["verifierCiphertext", "verifierNonce", "expiresAt"])
        .where("stateHash", "=", hashSessionToken(id))
        .where("kind", "=", REQUEST_KIND)
        .executeTakeFirst();
      if (!row || row.expiresAt <= new Date()) return null;
      return decryptSecret(
        row.verifierCiphertext,
        row.verifierNonce,
        key,
        "sso-state",
      );
    },
    async removeAsync(id: string | null): Promise<string | null> {
      if (!id) return null;
      const row = await db
        .deleteFrom("oauthStates")
        .where("stateHash", "=", hashSessionToken(id))
        .where("kind", "=", REQUEST_KIND)
        .returning(["verifierCiphertext", "verifierNonce"])
        .executeTakeFirst();
      if (!row) return null;
      return decryptSecret(
        row.verifierCiphertext,
        row.verifierNonce,
        key,
        "sso-state",
      );
    },
  };
}
