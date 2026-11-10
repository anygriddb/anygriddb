import { z } from "zod";
import { rollupFnSchema } from "./field-config";
import { columnNameSchema, labelSchema } from "./names";
import {
  columnDefinitionSchema,
  descriptionSchema,
  importIdSchema,
} from "./schemas";
import { viewConfigSchema, viewTypeSchema } from "./view-config";
import { ROLES } from "./rbac";
import { trimRuns } from "./plain-text";

/**
 * Portable JSON of one base: schema, views, optional rows. Versioned.
 * Version 2 adds members, people by email, and attachments: with files,
 * the JSON is `snapshot.json` in a ZIP archive that holds them
 * (`files/<id>`). Version 1 files still import.
 */
export const SNAPSHOT_KIND = "anygriddb.base" as const;
export const SNAPSHOT_VERSION = 2 as const;

/** Soft cap so a snapshot stays a file, not a warehouse dump. */
export const MAX_SNAPSHOT_ROWS = 100_000;
export const MAX_SNAPSHOT_TABLES = 100;
export const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024;
/** An archive with files: under ZIP's 4 GiB without ZIP64. */
export const MAX_SNAPSHOT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 50_000;
/** The JSON inside an archive. */
export const SNAPSHOT_ENTRY = "snapshot.json";

/** A file's id inside a snapshot: its entry is `files/<id>`. */
const fileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** An attachment cell's file, by its id in the snapshot. */
export const snapshotFileRefSchema = z
  .object({ file: fileIdSchema, name: z.string().min(1).max(255) })
  .strict();

const cellSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
  z.array(snapshotFileRefSchema).max(100),
]);

/** A file an archive holds, checked against its size and SHA-256. */
export const snapshotFileSchema = z
  .object({
    id: fileIdSchema,
    name: z.string().min(1).max(255),
    size: z.int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** A member's role on the base, by email: given back on request. */
export const snapshotMemberSchema = z
  .object({
    email: z.email().max(254),
    role: z.enum(ROLES),
  })
  .strict();

export const snapshotColumnSchema = columnDefinitionSchema;

export const snapshotViewSchema = z
  .object({
    name: labelSchema,
    viewType: viewTypeSchema,
    config: viewConfigSchema.optional(),
  })
  .strict();

export const snapshotTableSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/)
      .max(63),
    name: labelSchema,
    description: descriptionSchema.optional(),
    columns: z.array(snapshotColumnSchema).min(1).max(200),
    primary: columnNameSchema.optional(),
    views: z.array(snapshotViewSchema).max(50).default([]),
    /** Row cells keyed by column name; `__id` is the source row id for links. */
    rows: z
      .array(z.record(z.string(), cellSchema))
      .max(MAX_SNAPSHOT_ROWS)
      .optional(),
  })
  .strict();

export const snapshotLinkSchema = z
  .object({
    from: z.string().min(1).max(63),
    to: z.string().min(1).max(63),
    name: columnNameSchema.optional(),
    label: labelSchema,
    inverseLabel: labelSchema,
    /** The other end's field name, so lookups and views that use it resolve. */
    inverseName: columnNameSchema.optional(),
    /** False for a one-way link: no field on the other table. */
    twoWay: z.boolean().default(true),
    multiple: z.boolean(),
    /** Source row `__id` → target `__id` list. */
    links: z
      .array(
        z
          .object({
            from: z.string().min(1).max(64),
            to: z.array(z.string().min(1).max(64)).min(1).max(500),
          })
          .strict(),
      )
      .max(MAX_SNAPSHOT_ROWS)
      .optional(),
  })
  .strict();

export const snapshotComputedSchema = z
  .object({
    table: z.string().min(1).max(63),
    name: columnNameSchema.optional(),
    label: labelSchema,
    relation: columnNameSchema,
    target: columnNameSchema,
    fn: rollupFnSchema.optional(),
  })
  .strict();

export const baseSnapshotSchema = z
  .object({
    kind: z.literal(SNAPSHOT_KIND),
    version: z.union([z.literal(1), z.literal(SNAPSHOT_VERSION)]),
    exportedAt: z.string().min(1).max(40).optional(),
    base: z
      .object({
        name: labelSchema,
        description: descriptionSchema.optional(),
      })
      .strict(),
    tables: z.array(snapshotTableSchema).min(1).max(MAX_SNAPSHOT_TABLES),
    links: z.array(snapshotLinkSchema).max(500).default([]),
    computed: z.array(snapshotComputedSchema).max(500).default([]),
    /** Version 2: the base's members. User cells hold their emails. */
    members: z.array(snapshotMemberSchema).max(5_000).optional(),
    /** Version 2, with an archive: the files attachment cells name. */
    files: z.array(snapshotFileSchema).max(MAX_SNAPSHOT_FILES).optional(),
  })
  .strict();

export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type SnapshotFileRef = z.infer<typeof snapshotFileRefSchema>;
export type BaseSnapshot = z.infer<typeof baseSnapshotSchema>;
export type SnapshotTable = z.infer<typeof snapshotTableSchema>;
export type SnapshotLink = z.infer<typeof snapshotLinkSchema>;

export const exportSnapshotJobInputSchema = z
  .object({
    baseId: z.uuid(),
    withData: z.boolean().default(true),
  })
  .strict();

export type ExportSnapshotJobInput = z.infer<
  typeof exportSnapshotJobInputSchema
>;

/**
 * A copy of a base in one step: its snapshot read into a new base, so the
 * copy carries what a snapshot does (rows, attachments, and user cells by
 * email).
 */
export const duplicateBaseJobInputSchema = z
  .object({
    baseId: z.uuid(),
    name: labelSchema,
    withData: z.boolean().default(true),
  })
  .strict();

export type DuplicateBaseJobInput = z.infer<typeof duplicateBaseJobInputSchema>;

export const duplicateBaseInputSchema = z
  .object({
    baseId: z.uuid(),
    name: labelSchema.optional(),
    withData: z.boolean().default(true),
  })
  .strict();

export const importSnapshotJobInputSchema = z
  .object({
    /** Staged upload id from `POST /api/snapshot/upload`. */
    snapshotId: importIdSchema,
    name: labelSchema.optional(),
    /** Gives members with an account here their role back. */
    restoreMembers: z.boolean().default(false),
  })
  .strict();

export type ImportSnapshotJobInput = z.infer<
  typeof importSnapshotJobInputSchema
>;

/** Filename for a downloaded snapshot: an archive when it holds files. */
export function snapshotFilename(baseName: string, archive = false): string {
  const safe = trimRuns(
    baseName.normalize("NFKD").replace(/[^\w.-]+/g, "_"),
    "_",
  ).slice(0, 80);
  return `${safe || "base"}.anygriddb.${archive ? "zip" : "json"}`;
}
