/**
 * The attributes an instance knows of a person, and each account's values
 * (ADR 0142): what a rule may name as "the reader's ward". Both are on the
 * change trail, written by whoever gives access, or by the identity
 * provider for an attribute bound to a field of SCIM's enterprise
 * extension.
 */
import {
  AppError,
  attributeKeySchema,
  ceilingOf,
  labelSchema,
  NO_ENTERPRISE,
  SCIM_ENTERPRISE_FIELDS,
  type ScimEnterprise,
  type ScimEnterpriseField,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { sqlArray } from "../auth/delegated.js";
import { withAudit, type AuditTx } from "./audit-context.js";
import { postgresCode } from "./pg-error.js";

/** The most values an account holds of one attribute: two wards, three sites. */
const MAX_VALUES = ceilingOf("account.attribute_values");

const valuesSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(MAX_VALUES)
  .refine((values) => new Set(values).size === values.length)
  .refine((values) => values.join("").length <= 4_000);

export const attributeInputSchema = z
  .object({
    key: attributeKeySchema,
    label: labelSchema.pipe(z.string().max(60)),
    scimField: z.enum(SCIM_ENTERPRISE_FIELDS).nullable(),
  })
  .strict();

export const accountAttributesInputSchema = z
  .object({
    userId: z.uuid(),
    /** Each attribute's values; an empty list takes them away. */
    values: z.record(attributeKeySchema, valuesSchema),
  })
  .strict();

export type PersonAttribute = {
  key: string;
  label: string;
  scimField: ScimEnterpriseField | null;
  /** How many accounts hold a value of it. */
  holders: number;
};

/** The catalogue, by label. */
export async function listAttributes(db: Database): Promise<PersonAttribute[]> {
  const rows = await db
    .selectFrom("personAttributes as p")
    .select([
      "p.key",
      "p.label",
      "p.scimField",
      sql<number>`(select count(*)::int from account_attributes a where a.key = p.key)`.as(
        "holders",
      ),
    ])
    .orderBy(sql`lower(p.label)`)
    .execute();
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    scimField: (row.scimField as ScimEnterpriseField | null) ?? null,
    holders: row.holders,
  }));
}

function rethrowTaken(error: unknown): never {
  if (postgresCode(error) === "23505") {
    throw new AppError("attribute_exists");
  }
  throw error;
}

/** Adds an attribute to the catalogue. */
export async function createAttribute(
  db: Database,
  actorId: string,
  input: z.infer<typeof attributeInputSchema>,
): Promise<void> {
  try {
    await withAudit(db, { userId: actorId, source: "web" }, (tx) =>
      tx
        .insertInto("personAttributes")
        .values({
          key: input.key,
          label: input.label,
          scimField: input.scimField,
          createdBy: actorId,
        })
        .execute(),
    );
  } catch (error) {
    rethrowTaken(error);
  }
}

/** Renames an attribute, or binds it to another field of SCIM, or to none. */
export async function updateAttribute(
  db: Database,
  actorId: string,
  input: z.infer<typeof attributeInputSchema>,
): Promise<void> {
  try {
    const updated = await withAudit(
      db,
      { userId: actorId, source: "web" },
      (tx) =>
        tx
          .updateTable("personAttributes")
          .set({ label: input.label, scimField: input.scimField })
          .where("key", "=", input.key)
          .executeTakeFirst(),
    );
    if (updated.numUpdatedRows === 0n) throw new AppError("unknown_attribute");
  } catch (error) {
    rethrowTaken(error);
  }
}

/**
 * Takes an attribute out of the catalogue, with every account's values of
 * it: a rule that names it keeps no row from then on.
 */
export async function removeAttribute(
  db: Database,
  actorId: string,
  key: string,
): Promise<void> {
  const removed = await withAudit(
    db,
    { userId: actorId, source: "web" },
    (tx) =>
      tx
        .deleteFrom("personAttributes")
        .where("key", "=", key)
        .executeTakeFirst(),
  );
  if (removed.numDeletedRows === 0n) throw new AppError("unknown_attribute");
}

/** One account's values, by attribute. */
export async function accountAttributes(
  db: Pick<Database, "selectFrom">,
  userId: string,
): Promise<Record<string, string[]>> {
  const rows = await db
    .selectFrom("accountAttributes")
    .select(["key", "values"])
    .where("userId", "=", userId)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.key, row.values]));
}

/** Writes one account's values of some attributes; an empty list removes them. */
async function writeValues(
  tx: AuditTx,
  actorId: string,
  userId: string,
  values: Readonly<Record<string, readonly string[]>>,
): Promise<void> {
  for (const [key, list] of Object.entries(values)) {
    if (list.length === 0) {
      await tx
        .deleteFrom("accountAttributes")
        .where("userId", "=", userId)
        .where("key", "=", key)
        .execute();
      continue;
    }
    await tx
      .insertInto("accountAttributes")
      .values({
        userId,
        key,
        values: sqlArray(list, "text"),
        updatedBy: actorId,
      })
      .onConflict((conflict) =>
        conflict.columns(["userId", "key"]).doUpdateSet({
          values: sqlArray(list, "text"),
          updatedBy: actorId,
          updatedAt: sql`now()`,
        }),
      )
      .execute();
  }
}

/**
 * Sets an account's values, as whoever gives access sets them. An
 * attribute the identity provider keeps for an account it provisions is
 * its own to change (`attribute_provisioned`), and one the catalogue does
 * not hold is refused.
 */
export async function setAccountAttributes(
  db: Database,
  actorId: string,
  input: z.infer<typeof accountAttributesInputSchema>,
): Promise<void> {
  const keys = Object.keys(input.values);
  if (keys.length === 0) return;
  await withAudit(db, { userId: actorId, source: "web" }, async (tx) => {
    const account = await tx
      .selectFrom("users")
      .select(["id", "scimUserName"])
      .where("id", "=", input.userId)
      .executeTakeFirst();
    if (!account) throw new AppError("unknown_account");
    const known = await tx
      .selectFrom("personAttributes")
      .select(["key", "scimField"])
      .where("key", "in", keys)
      .execute();
    if (known.length !== keys.length) throw new AppError("unknown_attribute");
    if (
      account.scimUserName !== null &&
      known.some((attribute) => attribute.scimField !== null)
    ) {
      throw new AppError("attribute_provisioned");
    }
    await writeValues(tx, actorId, input.userId, input.values);
  });
}

/** The attributes bound to a field of SCIM's enterprise extension. */
async function boundAttributes(
  db: Pick<Database, "selectFrom">,
): Promise<Array<{ key: string; field: ScimEnterpriseField }>> {
  const rows = await db
    .selectFrom("personAttributes")
    .select(["key", "scimField"])
    .where("scimField", "is not", null)
    .execute();
  return rows.flatMap((row) =>
    row.scimField === null
      ? []
      : [{ key: row.key, field: row.scimField as ScimEnterpriseField }],
  );
}

/**
 * Each account's enterprise fields as the instance keeps them: the first
 * value of the attribute bound to each, none where no attribute is.
 */
export async function enterpriseOf(
  db: Pick<Database, "selectFrom">,
  userIds: readonly string[],
): Promise<Map<string, ScimEnterprise>> {
  const found = new Map<string, ScimEnterprise>();
  const bound = await boundAttributes(db);
  if (userIds.length === 0 || bound.length === 0) return found;
  const rows = await db
    .selectFrom("accountAttributes")
    .select(["userId", "key", "values"])
    .where("userId", "in", [...userIds])
    .where(
      "key",
      "in",
      bound.map((attribute) => attribute.key),
    )
    .execute();
  const fieldOf = new Map(
    bound.map((attribute) => [attribute.key, attribute.field]),
  );
  for (const row of rows) {
    const field = fieldOf.get(row.key);
    if (!field) continue;
    found.set(row.userId, {
      ...(found.get(row.userId) ?? NO_ENTERPRISE),
      [field]: row.values[0] ?? null,
    });
  }
  return found;
}

/**
 * The values the identity provider sends for the attributes bound to a
 * field of SCIM's enterprise extension, at each provisioning of an account:
 * a field it no longer sends takes the value away. Only what changed is
 * written, so the trail says what the provider changed.
 */
export async function provisionAttributes(
  tx: AuditTx,
  actorId: string,
  userId: string,
  enterprise: ScimEnterprise,
): Promise<void> {
  const bound = await boundAttributes(tx);
  if (bound.length === 0) return;
  const held = await accountAttributes(tx, userId);
  const changed = bound.flatMap(({ key, field }) => {
    const sent = enterprise[field];
    const next = sent === null ? [] : [sent];
    const before = held[key] ?? [];
    return before.length === next.length &&
      before.every((value, index) => value === next[index])
      ? []
      : [[key, next] as const];
  });
  if (changed.length > 0) {
    await writeValues(tx, actorId, userId, Object.fromEntries(changed));
  }
}

/** The attributes a rule may name, for whoever sets one: keys and labels. */
export async function attributeChoices(
  db: Pick<Database, "selectFrom">,
): Promise<Array<{ key: string; label: string }>> {
  return db
    .selectFrom("personAttributes")
    .select(["key", "label"])
    .orderBy(sql`lower(label)`)
    .execute();
}

/** Refuses a rule that names an attribute the catalogue does not hold. */
export async function assertKnownAttributes(
  db: Pick<Database, "selectFrom">,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  const known = await db
    .selectFrom("personAttributes")
    .select("key")
    .where("key", "in", [...keys])
    .execute();
  if (known.length !== new Set(keys).size) {
    throw new AppError("unknown_attribute");
  }
}
