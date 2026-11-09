import { AppError, labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { signupDecision } from "../admin.js";

/**
 * The account for an SSO identity, created on first sign-in when the
 * instance's sign-up policy allows it.
 */
export async function userForEmail(
  db: Database,
  email: string,
  name: string,
  adminEmails?: string,
): Promise<string> {
  const normalized = email.toLowerCase();
  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", normalized)
    .executeTakeFirst();
  if (existing) {
    return existing.id;
  }
  const decision = await signupDecision(db, normalized, adminEmails);
  if (!decision.allowed) {
    throw new AppError(decision.refusal ?? "signup_closed");
  }
  const displayName = labelSchema.safeParse(name).success
    ? name.trim()
    : "Utilisateur";
  const inserted = await db
    .insertInto("users")
    .values({ email: normalized, displayName, isAdmin: decision.isAdmin })
    .returning("id")
    .executeTakeFirst();
  const id = inserted?.id;
  if (!id) {
    throw new AppError("no_row");
  }
  return id;
}
