/**
 * A role given until a date (ADR 0146): its end set and taken away where
 * the role is given, and the roles that have ended removed within the
 * hour, written to the change trail as ended.
 */
import { AppError, type AclSubject } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { withAudit } from "./audit-context.js";
import { ERASED_USER_ID } from "./erasure.js";

/** The most roles one pass removes: the next hour takes the rest. */
const ENDED_PER_PASS = 500;

/**
 * Sets when a person's or a group's own role on a base or a table ends,
 * or takes the end away (`endsAt` null). An owner's role does not end, and
 * an end is to come. Under the giver's name on the change trail.
 */
export async function setRoleEnd(
  db: Database,
  actorId: string,
  input: {
    scope: "base" | "table";
    scopeId: string;
    subject: AclSubject;
    endsAt: Date | null;
  },
): Promise<void> {
  if (input.endsAt && input.endsAt.getTime() <= Date.now()) {
    throw new AppError("end_in_past");
  }
  const updated = await withAudit(
    db,
    {
      userId: actorId,
      ...(input.scope === "table" ? { tableId: input.scopeId } : {}),
      source: "web",
    },
    async (tx) => {
      const query = tx
        .updateTable("attributions")
        .set({ endsAt: input.endsAt })
        .where("scope", "=", input.scope)
        .where("scopeId", "=", input.scopeId);
      const subject =
        "userId" in input.subject
          ? query.where("userId", "=", input.subject.userId)
          : query.where("groupId", "=", input.subject.groupId);
      // An owner's role does not end: the base would be left without one.
      const owner = await tx
        .selectFrom("attributions")
        .select("id")
        .where("scope", "=", input.scope)
        .where("scopeId", "=", input.scopeId)
        .where("role", "=", "owner")
        .where(
          "userId" in input.subject ? "userId" : "groupId",
          "=",
          "userId" in input.subject
            ? input.subject.userId
            : input.subject.groupId,
        )
        .executeTakeFirst();
      if (owner && input.endsAt) throw new AppError("owner_never_ends");
      return subject.executeTakeFirst();
    },
  );
  if (updated.numUpdatedRows === 0n) throw new AppError("role_not_given");
}

/**
 * Removes the roles whose end has come, each under the name of whoever
 * gave it, from the source `ended`: the trail says a role ended, not that
 * someone took it away. Returns how many went.
 */
export async function endRoles(db: Database): Promise<number> {
  const ended = await db
    .selectFrom("attributions")
    .select(["id", "givenBy", "scope", "scopeId"])
    .where("endsAt", "<=", new Date())
    .where("scope", "in", ["base", "table"])
    .orderBy("endsAt")
    .limit(ENDED_PER_PASS)
    .execute();
  for (const role of ended) {
    await withAudit(
      db,
      {
        userId: role.givenBy ?? ERASED_USER_ID,
        ...(role.scope === "table" && role.scopeId
          ? { tableId: role.scopeId }
          : {}),
        source: "ended",
      },
      (tx) =>
        tx
          .deleteFrom("attributions")
          .where("id", "=", role.id)
          .where("endsAt", "<=", new Date())
          .execute(),
    );
  }
  return ended.length;
}
