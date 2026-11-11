/**
 * Sign-ups whose address is not proved yet (ADR 0058). A password sign-up
 * keeps the name and the password's hash here, and mails a link to the
 * address; the account is made only when that link is opened and the same
 * password is given again. Until then there is no account: nothing given
 * or joined to an account by its address can reach a person who does not
 * read that mailbox.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";

/** A link works for a day. */
export const SIGNUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Live requests one address may have: past this, a sign-up gets the same
 * answer and mails nothing, so nobody can flood a mailbox with links.
 */
export const MAX_PENDING_PER_ADDRESS = 3;

const SIGNUP_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function hashSignupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SignupRequest = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
};

/**
 * Keeps a sign-up and returns its link's token, or null when the address
 * already has as many live requests as it may: the caller answers the
 * same, and sends nothing.
 */
export async function createSignupRequest(
  db: Database,
  input: { email: string; displayName: string; passwordHash: string },
): Promise<{ token: string; expiresAt: Date } | null> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SIGNUP_LINK_TTL_MS);
  return db.transaction().execute(async (tx) => {
    // Two sign-ups racing for one address count each other.
    await tx
      .selectFrom("signupRequests")
      .select("id")
      .where("email", "=", input.email)
      .where("expiresAt", ">", new Date())
      .forUpdate()
      .execute();
    const live = await tx
      .selectFrom("signupRequests")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("email", "=", input.email)
      .where("expiresAt", ">", new Date())
      .executeTakeFirstOrThrow();
    if (Number(live.count) >= MAX_PENDING_PER_ADDRESS) return null;
    await tx
      .insertInto("signupRequests")
      .values({
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        tokenHash: hashSignupToken(token),
        expiresAt,
      })
      .execute();
    return { token, expiresAt };
  });
}

/** The live request a link names, or null. */
export async function findSignupRequest(
  db: Database,
  token: string,
): Promise<SignupRequest | null> {
  if (!SIGNUP_TOKEN.test(token)) return null;
  const row = await db
    .selectFrom("signupRequests")
    .select(["id", "email", "displayName", "passwordHash"])
    .where("tokenHash", "=", hashSignupToken(token))
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  return row ?? null;
}

/** Expired requests: an address that never answered leaves nothing. */
export async function purgeSignupRequests(db: Database): Promise<number> {
  const deleted = await db
    .deleteFrom("signupRequests")
    .where("expiresAt", "<", new Date())
    .returning("id")
    .execute();
  return deleted.length;
}

/** Where the link sends the person. */
export function signupLinkUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/signup/${token}`;
}
