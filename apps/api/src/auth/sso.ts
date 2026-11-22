import { AppError, labelSchema, madeNames } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { signupDecision } from "../admin.js";
import { readGateSettings } from "../settings.js";

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

type BindingOptions = {
  /** Whether the address may reach an account that already exists. */
  linkExisting?: boolean;
  /** False when the provider says the address is not verified. */
  mayCreate?: boolean;
  /** Whether the other protocol's provider is still set up here. */
  otherProtocolLive?: boolean;
  /** Told when an account that existed is bound to a subject. */
  onBound?: (userId: string) => void;
};

/**
 * Whether a binding keeps this identity off the account. There is one
 * provider per protocol: a binding to another issuer of the same protocol
 * is to a provider since replaced, and one of the other protocol holds
 * while that provider is still set up.
 */
function bindingHolds(
  binding: { provider: string; issuer: string },
  identity: SsoIdentity,
  otherProtocolLive: boolean,
): boolean {
  return binding.provider === identity.provider
    ? binding.issuer === identity.issuer
    : otherProtocolLive;
}

/**
 * The account for a sign-on identity. The subject comes first: it finds the
 * account bound to it, whatever its address is now, or whether the provider
 * sends one. Only a first binding reads the address, and it never reaches an
 * account that another subject holds. A new account is made when the
 * instance's sign-up policy allows it.
 */
export async function userForIdentity(
  db: Database,
  identity: SsoIdentity,
  email: string | null,
  name: string,
  adminEmails?: string,
  options: BindingOptions = {},
): Promise<string> {
  const { provider, issuer, subject } = identity;
  const found = await db.transaction().execute(async (tx) => {
    if (subject) {
      const bound = await tx
        .updateTable("ssoIdentities")
        .set({ lastSeenAt: new Date() })
        .where("provider", "=", provider)
        .where("issuer", "=", issuer)
        .where("subject", "=", subject)
        .returning("userId")
        .executeTakeFirst();
      if (bound) return { userId: bound.userId, boundExisting: false };
    }
    if (email === null) throw new AppError("invalid_credentials");
    const normalized = email.toLowerCase();
    // Locked: two subjects bringing one address bind it one at a time.
    const existing = await tx
      .selectFrom("users")
      .select("id")
      .where("email", "=", normalized)
      .forUpdate()
      .executeTakeFirst();
    // An unverified address must not take over an account that already
    // exists. A new account can still be created when sign-up allows it.
    if (existing && options.linkExisting === false) {
      throw new AppError("invalid_credentials");
    }
    let userId = existing?.id;
    if (userId) {
      const bindings = await tx
        .selectFrom("ssoIdentities")
        .select(["provider", "issuer"])
        .where("userId", "=", userId)
        .execute();
      const otherProtocolLive = options.otherProtocolLive ?? true;
      if (
        bindings.some((binding) =>
          bindingHolds(binding, identity, otherProtocolLive),
        )
      ) {
        throw new AppError("invalid_credentials");
      }
    }
    const boundExisting = userId !== undefined && subject !== null;
    if (!userId) {
      if (options.mayCreate === false) {
        throw new AppError("invalid_credentials");
      }
      const decision = await signupDecision(tx, normalized, adminEmails);
      if (!decision.allowed) {
        throw new AppError(decision.refusal ?? "signup_closed");
      }
      // The first account takes the operator's token (ADR 0080), which a
      // sign-on through a provider has no place to give: it is made from
      // the password form.
      if (decision.firstAccount) {
        throw new AppError("install_token_required");
      }
      // A provider that sends no name the instance can keep: the word
      // for it, in the instance's language, which the person may change.
      const displayName = labelSchema.safeParse(name).success
        ? name.trim()
        : madeNames((await readGateSettings(db)).defaultLocale).account;
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
    return { userId, boundExisting };
  });
  if (found.boundExisting) options.onBound?.(found.userId);
  return found.userId;
}
