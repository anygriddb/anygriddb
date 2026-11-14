import { z } from "zod";
import { AppError } from "./errors";

/**
 * Deleted bases, tables, fields, and views wait in the trash this long,
 * with their data, before they are purged for good, unless an
 * administrator chose otherwise (`trashDays`).
 */
export const TRASH_DAYS = 30;

const TRASH_KINDS = ["base", "table", "column", "view"] as const;
const trashItemSchema = z
  .object({ kind: z.enum(TRASH_KINDS), id: z.uuid() })
  .strict();

export type TrashItem = z.infer<typeof trashItemSchema>;

export const trashListInputSchema = z.object({ baseId: z.uuid() }).strict();

export const restoreInputSchema = trashItemSchema;

/** Deletes items of a base's trash for good; without items, all of them. */
export const purgeTrashInputSchema = z
  .object({
    baseId: z.uuid(),
    items: z.array(trashItemSchema).min(1).max(100).optional(),
  })
  .strict();

/** A purge as the worker runs it: chosen items, a whole base trash, or what is due. */
export const trashPurgeJobInputSchema = z
  .object({
    baseId: z.uuid().optional(),
    items: z.array(trashItemSchema).min(1).max(100).optional(),
    due: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.due) !== Boolean(input.baseId),
    "Invalid job",
  );
/** When an item deleted at `deletedAt` is purged. */
export function purgeDate(deletedAt: Date, days: number = TRASH_DAYS): Date {
  return new Date(deletedAt.getTime() + days * 86_400_000);
}

/** Items deleted before this moment are due for purging. */
export function purgeCutoff(now: Date, days: number = TRASH_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * A name for something coming back from the trash: its own when free,
 * else the first free "Name (2)", "Name (3)"… Names compare without
 * case, as table and field names do, and stay within `max` characters.
 */
export function restoredName(
  name: string,
  taken: Iterable<string>,
  max = 100,
): string {
  const used = new Set([...taken].map((item) => item.trim().toLowerCase()));
  if (!used.has(name.trim().toLowerCase())) return name;
  for (let index = 2; index < 1_000; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${name.slice(0, max - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new AppError("invalid_restore");
}
