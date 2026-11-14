/**
 * What a base's owners are told when an administrator gives a role on it
 * (ROADMAP #91): an administrator decides who sees which base (ADR 0057),
 * and those who answer for the base learn of it in the app, whoever the
 * role went to and by whichever way. One notice for one gesture.
 */
import type { Role } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { Publisher } from "../realtime/bus.js";
import { gridChannel } from "../realtime/channels.js";

/** What was given: to a person, to several at once, to a group, or to a group's new member. */
export type RoleGift =
  | { to: "person"; userId: string; role: Role }
  | { to: "people"; count: number }
  | { to: "group"; groupId: string; role: Role }
  | { to: "member"; userId: string; groupId: string; role: Role };

export type RoleNoticeDeps = {
  db: Database;
  bus: Publisher;
  log: (error: unknown, message: string) => void;
};

/**
 * Tells the base's owners, in the app. Not told: the administrator who
 * did it, whoever received the role, and a disabled account. An owner
 * named keeps the notice it always had (`owner_named`). A failure to
 * tell is logged, never thrown: the role is already given.
 */
export async function tellOwnersOfRole(
  deps: RoleNoticeDeps,
  input: { baseId: string; actorId: string; gift: RoleGift },
): Promise<number> {
  try {
    return await tell(deps, input);
  } catch (error) {
    deps.log(error, "role notice failed");
    return 0;
  }
}

async function tell(
  deps: RoleNoticeDeps,
  input: { baseId: string; actorId: string; gift: RoleGift },
): Promise<number> {
  const { gift } = input;
  const receiver = "userId" in gift ? gift.userId : null;
  const [base, person, group, owners] = await Promise.all([
    deps.db
      .selectFrom("bases")
      .select("name")
      .where("id", "=", input.baseId)
      .executeTakeFirst(),
    receiver
      ? deps.db
          .selectFrom("users")
          .select("displayName")
          .where("id", "=", receiver)
          .executeTakeFirst()
      : undefined,
    "groupId" in gift
      ? deps.db
          .selectFrom("groups")
          .select("displayName")
          .where("id", "=", gift.groupId)
          .executeTakeFirst()
      : undefined,
    deps.db
      .selectFrom("users as u")
      .select("u.id")
      .where("u.disabledAt", "is", null)
      .where("u.id", "<>", input.actorId)
      .where("u.id", "<>", receiver ?? input.actorId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("roleBindings as b")
            .select("b.id")
            .whereRef("b.userId", "=", "u.id")
            .where("b.scope", "=", "base")
            .where("b.scopeId", "=", input.baseId)
            .where("b.role", "=", "owner"),
        ),
      )
      .execute(),
  ]);
  if (!base || owners.length === 0) return 0;
  const named = gift.to === "person" && gift.role === "owner";
  const data: Record<string, string> = {
    baseId: input.baseId,
    base: base.name,
  };
  if (person) data.name = person.displayName;
  if (!named) {
    if (group) data.group = group.displayName;
    if ("role" in gift) data.role = gift.role;
    if (gift.to === "people") data.count = String(gift.count);
  }
  await deps.db
    .insertInto("notifications")
    .values(
      owners.map((owner) => ({
        userId: owner.id,
        kind: named ? ("owner_named" as const) : ("role_given" as const),
        actorId: input.actorId,
        data,
      })),
    )
    .execute();
  for (const owner of owners) {
    try {
      await deps.bus.publish(
        gridChannel(owner.id),
        JSON.stringify({ type: "notification", channel: owner.id }),
      );
    } catch (error) {
      deps.log(error, "notification publish failed");
    }
  }
  return owners.length;
}
