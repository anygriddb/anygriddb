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
 * (`files/<id>`). Version 3 takes the rows out of the JSON (ADR 0076):
 * each table's rows are lines of their own entry, `rows/<key>.ndjson`,
 * written and read one at a time, so a snapshot holds as many rows as the
 * instance's export and import ceilings allow. Versions 1 and 2 still
 * import.
 */
export const SNAPSHOT_KIND = "anygriddb.base" as const;
export const SNAPSHOT_VERSION = 3 as const;

/** The most rows a version 1 or 2 snapshot carries inside its JSON. */
export const MAX_SNAPSHOT_ROWS = 100_000;
/** One row's line in a version 3 entry. */
export const MAX_SNAPSHOT_LINE_BYTES = 4 * 1024 * 1024;
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
const snapshotFileSchema = z
  .object({
    id: fileIdSchema,
    name: z.string().min(1).max(255),
    size: z.int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** A member's role on the base, by email: given back on request. */
const snapshotMemberSchema = z
  .object({
    email: z.email().max(254),
    role: z.enum(ROLES),
  })
  .strict();

const snapshotColumnSchema = columnDefinitionSchema;

const snapshotViewSchema = z
  .object({
    name: labelSchema,
    viewType: viewTypeSchema,
    config: viewConfigSchema.optional(),
  })
  .strict();

const snapshotTableSchema = z
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
    /**
     * Versions 1 and 2: row cells keyed by column name; `__id` is the
     * source row id for links.
     */
    rows: z
      .array(z.record(z.string(), cellSchema))
      .max(MAX_SNAPSHOT_ROWS)
      .optional(),
    /** Version 3: how many lines the table's entry holds. */
    rowCount: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

const snapshotLinkSchema = z
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
    /**
     * Versions 1 and 2: source row `__id` → target `__id` list. In version
     * 3 a row's line names its targets' sequence numbers under `name`.
     */
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

const snapshotComputedSchema = z
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
    version: z.union([z.literal(1), z.literal(2), z.literal(SNAPSHOT_VERSION)]),
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
  .strict()
  .superRefine((snapshot, context) => {
    // Version 3 keeps its rows in their entries, versions 1 and 2 in the
    // JSON: one place each, never both.
    const lines = snapshot.version === SNAPSHOT_VERSION;
    for (const table of snapshot.tables) {
      if (lines ? table.rows !== undefined : table.rowCount !== undefined) {
        context.addIssue({ code: "custom", message: "rows" });
      }
    }
    if (lines && snapshot.links.some((link) => link.links !== undefined)) {
      context.addIssue({ code: "custom", message: "links" });
    }
  });

/** The entry of a version 3 archive that holds a table's rows. */
export function snapshotRowsEntry(key: string): string {
  return `rows/${key}.ndjson`;
}

/** A row's sequence number and place, as a version 3 line names them. */
const lineSeqSchema = z.string().regex(/^[1-9]\d{0,18}$/);
const linePositionSchema = z
  .string()
  .regex(/^-?\d{1,19}(?:\.\d{1,16000})?$/)
  .max(16_100);

/**
 * One row of a version 3 entry: its cells by column name, its sequence
 * number (`__seq`) and place (`__position`), and under each link's name the
 * sequence numbers of the rows it links to.
 */
export const snapshotLineSchema = z
  .object({ __seq: lineSeqSchema, __position: linePositionSchema })
  .catchall(cellSchema);

export type SnapshotLine = z.infer<typeof snapshotLineSchema>;

/** The rows a snapshot carries, in its JSON or in its entries. */
export function snapshotRowCount(snapshot: {
  tables: ReadonlyArray<{ rows?: readonly unknown[]; rowCount?: number }>;
}): number {
  return snapshot.tables.reduce(
    (sum, table) => sum + (table.rows?.length ?? table.rowCount ?? 0),
    0,
  );
}

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
/** Filename for a downloaded snapshot: an archive when it holds files. */
export function snapshotFilename(baseName: string, archive = false): string {
  const safe = trimRuns(
    baseName.normalize("NFKD").replace(/[^\w.-]+/g, "_"),
    "_",
  ).slice(0, 80);
  return `${safe || "base"}.anygriddb.${archive ? "zip" : "json"}`;
}
