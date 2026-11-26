/**
 * Delegated accesses (ADR 0131, §5): what acts without its author's
 * session, one row of `delegated_accesses` whatever its kind. A revoked
 * one stays, and acts on nothing; one past its end neither.
 */
import { createHash } from "node:crypto";
import { type Permission, PERMISSIONS, rolePermissions } from "@anygriddb/core";
import { sql, type ExpressionBuilder } from "kysely";

/** The SHA-256 of a secret, as the table keeps it: never the secret. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * An access that acts now: not revoked, not past its end. Its kind and
 * whatever else holds it (its author's state, a policy) are the caller's.
 */
export function liveAccess(
  eb: ExpressionBuilder<
    { a: { revokedAt: Date | null; endsAt: Date | null } },
    "a"
  >,
) {
  return eb.and([
    eb("a.revokedAt", "is", null),
    eb.or([eb("a.endsAt", "is", null), eb("a.endsAt", ">", sql<Date>`now()`)]),
  ]);
}

/** A token's two switches, as a person or an application chooses them. */
export type TokenSwitches = { readOnly?: boolean; allowDelete?: boolean };

/**
 * What a token is entrusted of its author's permissions on a base: a
 * read-only one what a viewer may, one kept from deleting all but that;
 * null, all its author holds.
 */
export function entrustedOf(switches: TokenSwitches): Permission[] | null {
  if (switches.readOnly === true) return rolePermissions("viewer");
  if (switches.allowDelete === false) {
    return PERMISSIONS.filter((permission) => permission !== "rows.delete");
  }
  return null;
}

/** The permissions a stored list names, in the catalogue's order. */
export function permissionsOf(
  stored: readonly string[] | null,
): Permission[] | null {
  if (stored === null) return null;
  return PERMISSIONS.filter((permission) => stored.includes(permission));
}

/** A token's switches read back from what it was entrusted. */
export function switchesOf(entrusted: readonly Permission[] | null): {
  readOnly: boolean;
  allowDelete: boolean;
} {
  if (entrusted === null) return { readOnly: false, allowDelete: true };
  const readOnly = !entrusted.includes("rows.write");
  return {
    readOnly,
    allowDelete: !readOnly && entrusted.includes("rows.delete"),
  };
}

/** A token's end: every token has one (`delegated_accesses_token_end`). */
export function tokenEnd(endsAt: Date | null): Date {
  if (endsAt === null) throw new Error("a token without an end");
  return endsAt;
}

/**
 * A list as a PostgreSQL array: the client sends a JavaScript array as
 * JSON, which a `uuid[]` or a `text[]` column refuses.
 */
export function sqlArray(values: readonly string[], type: "uuid" | "text") {
  return type === "uuid"
    ? sql<
        string[]
      >`array[${sql.join(values.map((value) => sql`${value}::uuid`))}]::uuid[]`
    : sql<
        string[]
      >`array[${sql.join(values.map((value) => sql`${value}`))}]::text[]`;
}
