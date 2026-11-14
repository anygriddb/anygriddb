/**
 * Handing a leaving person's work to someone who stays (ROADMAP #21): the
 * bases they alone own, and the automations and webhooks they made. Their
 * account is left as it is, and so are their personal API tokens, which
 * the administrator may revoke in the same gesture.
 */
import {
  AppError,
  effectiveTableRole,
  roleAllows,
  type Binding,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { otherAccount } from "../admin-control.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import { withAudit, type AuditTx } from "./audit-context.js";
import { ERASED_USER_ID } from "./erasure.js";
import { bindRole, soleOwnerBases } from "./members.js";

export const handOverInputSchema = z
  .object({
    fromUserId: z.uuid(),
    /** The active account that takes over. */
    toUserId: z.uuid(),
    /** Revoke the leaving person's API tokens too: they are never moved. */
    revokeTokens: z.boolean().default(false),
  })
  .strict();

/** An automation or a webhook, as the dialog and the result name it. */
export type HandoffItem = {
  id: string;
  name: string;
  table: string;
  base: string;
};

type Made = HandoffItem & { tableId: string; baseId: string };

/** The automations a person made, with where each is. */
function automationsOf(
  db: Database | AuditTx,
  userId: string,
): Promise<Made[]> {
  return db
    .selectFrom("automations as m")
    .innerJoin("dataTables as t", "t.id", "m.tableId")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .select([
      "m.id",
      "m.name",
      "t.name as table",
      "b.name as base",
      "t.id as tableId",
      "t.baseId",
    ])
    .where("m.createdBy", "=", userId)
    .orderBy("b.name", "asc")
    .orderBy("t.name", "asc")
    .orderBy("m.name", "asc")
    .execute();
}

/** The webhooks a person made, with where each is. */
function webhooksOf(db: Database | AuditTx, userId: string): Promise<Made[]> {
  return db
    .selectFrom("webhooks as m")
    .innerJoin("dataTables as t", "t.id", "m.tableId")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .select([
      "m.id",
      "m.name",
      "t.name as table",
      "b.name as base",
      "t.id as tableId",
      "t.baseId",
    ])
    .where("m.createdBy", "=", userId)
    .orderBy("b.name", "asc")
    .orderBy("t.name", "asc")
    .orderBy("m.name", "asc")
    .execute();
}

const named = ({ id, name, table, base }: Made): HandoffItem => ({
  id,
  name,
  table,
  base,
});

/**
 * What there is to hand over, for the dialog: the bases the person alone
 * owns, what they made, and how many API tokens they hold.
 */
export async function handoffInfo(
  db: Database,
  actorId: string,
  userId: string,
): Promise<{
  bases: { id: string; name: string }[];
  automations: HandoffItem[];
  webhooks: HandoffItem[];
  tokens: number;
}> {
  await otherAccount(db, actorId, userId);
  const [bases, automations, webhooks, tokens] = await Promise.all([
    soleOwnerBases(db, userId),
    automationsOf(db, userId),
    webhooksOf(db, userId),
    db
      .selectFrom("apiTokens")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("userId", "=", userId)
      .executeTakeFirst(),
  ]);
  return {
    bases,
    automations: automations.map(named),
    webhooks: webhooks.map(named),
    tokens: Number(tokens?.count ?? 0),
  };
}

/**
 * Hands over, in one transaction under the administrator's name:
 *
 * - the bases the person alone owns get the successor as an owner. The
 *   person's own role stays: taking it away, or disabling the account,
 *   is another gesture;
 * - an automation or a webhook runs with its author's rights, so it
 *   moves only where the successor may manage its table, once the bases
 *   above are theirs. The others stay with the person, and are named in
 *   the answer: they stop when that account is disabled;
 * - API tokens are never moved. They are revoked when asked.
 */
export async function handOver(
  db: Database,
  actorId: string,
  input: z.infer<typeof handOverInputSchema>,
): Promise<{
  bases: number;
  automations: { moved: number; kept: HandoffItem[] };
  webhooks: { moved: number; kept: HandoffItem[] };
  tokensRevoked: number;
}> {
  await otherAccount(db, actorId, input.fromUserId);
  if (input.toUserId === input.fromUserId) {
    throw new AppError("invalid_account");
  }
  return withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    const successor = await tx
      .selectFrom("users")
      .select("id")
      .where("id", "=", input.toUserId)
      .where("id", "<>", ERASED_USER_ID)
      .where("disabledAt", "is", null)
      .where("deprovisionedAt", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!successor) throw new AppError("unknown_account");

    const bases = await soleOwnerBases(tx, input.fromUserId);
    for (const base of bases) {
      await bindRole(tx, input.toUserId, "owner", base.id);
    }

    // The successor's roles, the bases just handed over among them.
    const bindings: Binding[] = await tx
      .selectFrom("roleBindings")
      .select(["role", "scope", "scopeId"])
      .where("userId", "=", input.toUserId)
      .execute();
    const manages = (item: Made) =>
      roleAllows(
        effectiveTableRole(bindings, item.tableId, item.baseId),
        "manage",
      );
    /** What moves, and what stays with the person. */
    const split = (made: Made[]) => ({
      moving: made.filter(manages).map((item) => item.id),
      kept: made.filter((item) => !manages(item)).map(named),
    });
    const theirAutomations = split(await automationsOf(tx, input.fromUserId));
    if (theirAutomations.moving.length > 0) {
      await tx
        .updateTable("automations")
        .set({ createdBy: input.toUserId })
        .where("id", "in", theirAutomations.moving)
        .execute();
    }
    const theirWebhooks = split(await webhooksOf(tx, input.fromUserId));
    if (theirWebhooks.moving.length > 0) {
      await tx
        .updateTable("webhooks")
        .set({ createdBy: input.toUserId })
        .where("id", "in", theirWebhooks.moving)
        .execute();
    }
    const automations = {
      moved: theirAutomations.moving.length,
      kept: theirAutomations.kept,
    };
    const webhooks = {
      moved: theirWebhooks.moving.length,
      kept: theirWebhooks.kept,
    };

    let tokensRevoked = 0;
    if (input.revokeTokens) {
      const revoked = await tx
        .deleteFrom("apiTokens")
        .where("userId", "=", input.fromUserId)
        .returning("id")
        .execute();
      tokensRevoked = revoked.length;
      if (tokensRevoked > 0) {
        await recordAuthEvent(tx, {
          action: "tokens_revoked",
          userId: input.fromUserId,
          actorId,
          method: "admin",
        });
      }
    }
    await recordAuthEvent(tx, {
      action: "account_updated",
      userId: input.fromUserId,
      actorId,
      method: "admin",
      detail: "handed_over",
    });
    return { bases: bases.length, automations, webhooks, tokensRevoked };
  });
}
