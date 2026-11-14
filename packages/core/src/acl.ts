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
  })
  .strict();

export const getTableAclInputSchema = z.object({ tableId: z.uuid() }).strict();

export const setTableAclInputSchema = z
  .object({
    tableId: z.uuid(),
    userId: z.uuid(),
    rowFilter: filterGroupSchema.nullable(),
    columns: z.array(columnAclEntrySchema).max(200),
  })
  .strict();

export const clearTableAclInputSchema = z
  .object({
    tableId: z.uuid(),
    userId: z.uuid(),
  })
  .strict();

export const viewAsInputSchema = z
  .object({
    tableId: z.uuid(),
    userId: z.uuid(),
    limit: z.int().min(1).max(50).default(10),
  })
  .strict();

/** One member's rules on a table: the rows they see, and each field's access. */
export type TableAcl = {
  userId: string;
  rowFilter: FilterGroup | null;
  columns: ColumnAclEntry[];
};
export type ColumnAclEntry = z.infer<typeof columnAclEntrySchema>;
