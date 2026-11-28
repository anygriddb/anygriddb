import { z } from "zod";
import { columnNameSchema } from "./names";
import { filterGroupSchema, type FilterGroup } from "./filter";

const COLUMN_ACCESS = ["hide", "read", "write"] as const;
export type ColumnAccess = (typeof COLUMN_ACCESS)[number];

const columnAccessSchema = z.enum(COLUMN_ACCESS);

export const columnAclEntrySchema = z
  .object({
    column: columnNameSchema,
    access: columnAccessSchema,
    /**
     * The rows, among those the rule reaches, on which the field has this
     * access; hidden on the others (ADR 0145). Absent, every row.
     */
    rows: filterGroupSchema.optional(),
  })
  .strict()
  // A field hidden on every row is hidden on some of them too.
  .refine((entry) => entry.rows === undefined || entry.access !== "hide", {
    message: "A hidden field holds on no row",
    path: ["rows"],
  });

export const getTableAclInputSchema = z.object({ tableId: z.uuid() }).strict();

/**
 * Whom a table's rule is about (ADR 0131): one person, or a group, whose
 * attribution on the table it narrows. Exactly one: an input that names
 * both, or neither, is refused.
 */
export type AclSubject = { userId: string } | { groupId: string };

const ruleShape = {
  tableId: z.uuid(),
  rowFilter: filterGroupSchema.nullable(),
  columns: z.array(columnAclEntrySchema).max(200),
};

export const setTableAclInputSchema = z.union([
  z.object({ ...ruleShape, userId: z.uuid() }).strict(),
  z.object({ ...ruleShape, groupId: z.uuid() }).strict(),
]);

export const clearTableAclInputSchema = z.union([
  z.object({ tableId: z.uuid(), userId: z.uuid() }).strict(),
  z.object({ tableId: z.uuid(), groupId: z.uuid() }).strict(),
]);

/** The subject an input names, without its other keys. */
export function aclSubjectOf(input: AclSubject): AclSubject {
  return "userId" in input
    ? { userId: input.userId }
    : { groupId: input.groupId };
}

export const viewAsInputSchema = z
  .object({
    tableId: z.uuid(),
    userId: z.uuid(),
    limit: z.int().min(1).max(50).default(10),
  })
  .strict();

/** One person's or one group's rules on a table: the rows, and each field's access. */
export type TableAcl = AclSubject & {
  rowFilter: FilterGroup | null;
  columns: ColumnAclEntry[];
};
export type ColumnAclEntry = z.infer<typeof columnAclEntrySchema>;
