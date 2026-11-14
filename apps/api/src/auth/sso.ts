import { AppError, labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { signupDecision } from "../admin.js";

/**
 * Who a sign-on provider says signed in: the provider, its issuer, and the
 * stable subject it names them by. A subject is null when the provider
 * gives none that lasts (a transient or address-shaped SAML NameID): the
 * address alone then finds the account, as the provider must verify it.
 */
type SsoIdentity = {
  provider: "oidc" | "saml";
  issuer: string;
  subject: string | null;
};

/** A SAML NameID that names the same person at every sign-in. */
export function stableNameId(
  nameId: string | undefined,
  format: string | undefined,
): string | null {
  if (!nameId) return null;
  return format?.endsWith(":nameid-format:persistent") ? nameId : null;
}

/**
 * The account for a sign-on identity. The subject finds an account bound to
 * it, whatever its address is now. Otherwise the address finds the account
 * and binds it, unless the account is already bound to another subject of
 * the same issuer: someone else then holds that address at the provider,
 * and the sign-in is refused. A new account is made when the instance's
 * sign-up policy allows it.
 */
export async function userForIdentity(
  db: Database,
  identity: SsoIdentity,
  email: string,
  name: string,
  adminEmails?: string,
  options: { linkExisting?: boolean } = {},
): Promise<string> {
  const normalized = email.toLowerCase();
  const { provider, issuer, subject } = identity;
  return db.transaction().execute(async (tx) => {
    if (subject) {
      const bound = await tx
        .updateTable("ssoIdentities")
        .set({ lastSeenAt: new Date() })
        .where("provider", "=", provider)
        .where("issuer", "=", issuer)
        .where("subject", "=", subject)
        .returning("userId")
        .executeTakeFirst();
      if (bound) return bound.userId;
    }
    const existing = await tx
      .selectFrom("users")
      .select("id")
      .where("email", "=", normalized)
      .executeTakeFirst();
    // An unverified address must not take over an account that already
    // exists. A new account can still be created when sign-up allows it.
    if (existing && options.linkExisting === false) {
      throw new AppError("invalid_credentials");
    }
    let userId = existing?.id;
    if (userId && subject) {
      const other = await tx
        .selectFrom("ssoIdentities")
        .select("subject")
        .where("provider", "=", provider)
        .where("issuer", "=", issuer)
        .where("userId", "=", userId)
        .executeTakeFirst();
      if (other) throw new AppError("invalid_credentials");
    }
    if (!userId) {
      const decision = await signupDecision(tx, normalized, adminEmails);
      if (!decision.allowed) {
        throw new AppError(decision.refusal ?? "signup_closed");
      }
      const displayName = labelSchema.safeParse(name).success
        ? name.trim()
        : "Utilisateur";
      const inserted = await tx
        .insertInto("users")
        .values({ email: normalized, displayName, isAdmin: decision.isAdmin })
        .returning("id")
        .executeTakeFirst();
      userId = inserted?.id;
      if (!userId) throw new AppError("no_row");
    }
    if (subject) {
      await tx
        .insertInto("ssoIdentities")
        .values({ provider, issuer, subject, userId })
        .execute();
    }
    return userId;
  });
}
