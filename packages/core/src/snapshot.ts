import { z } from "zod";
import { columnAclEntrySchema } from "./acl";
import {
  DASHBOARD_WIDGET_KINDS,
  dashboardWidgetConfigSchema,
  widgetConfigOn,
  widgetPlace,
} from "./dashboards";
import { rollupFnSchema } from "./field-config";
import { filterGroupSchema } from "./filter";
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
 * import. Version 4 (ADR 0117) is version 3 with each row's dates, authors,
 * and status: only what an instance writes for itself, a restore point or a
 * base's copy. It never leaves the instance, and is refused from a file.
 */
export const SNAPSHOT_KIND = "anygriddb.base" as const;
export const SNAPSHOT_VERSION = 3 as const;
export const SNAPSHOT_KEPT_VERSION = 4 as const;

/** The most rows a version 1 or 2 snapshot carries inside its JSON. */
export const MAX_SNAPSHOT_ROWS = 100_000;
/** One row's line in a version 3 entry. */
export const MAX_SNAPSHOT_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_SNAPSHOT_TABLES = 100;
/** Past these, a snapshot keeps the folders that hold a table. */
export const MAX_SNAPSHOT_FOLDERS = 500;
export const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024;
/** An archive with files: under ZIP's 4 GiB without ZIP64. */
export const MAX_SNAPSHOT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 50_000;
export const MAX_SNAPSHOT_DASHBOARDS = 500;
/** The widgets of one dashboard. */
export const MAX_SNAPSHOT_WIDGETS = 500;
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

/**
 * A person's own access to one table: the role that replaces the base's
 * there, and the rows and fields their rules leave them. Given back with
 * the members, so that nobody sees more of the new base than of the old.
 */
const snapshotTableAccessSchema = z
  .object({
    email: z.email().max(254),
    role: z.enum(ROLES).optional(),
    rowFilter: filterGroupSchema.optional(),
    columns: z.array(columnAclEntrySchema).max(200).optional(),
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
    /** Version 3, with the members: each person's own access to the table. */
    access: z.array(snapshotTableAccessSchema).max(5_000).optional(),
    /** The folder the table is kept in, by its name; none: the base's root. */
    folder: labelSchema.optional(),
  })
  .strict();

/**
 * A dashboard's widget: its settings as the dashboard keeps them, but for
 * the table and the view it reads. Those are ids of the base it was made
 * in: a snapshot names the table by its key, and the view by its rank
 * among that table's views.
 */
const snapshotWidgetSchema = z
  .object({
    title: labelSchema,
    kind: z.enum(DASHBOARD_WIDGET_KINDS),
    ...widgetPlace,
    table: z.string().min(1).max(63),
    view: z.int().min(0).max(49).optional(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

/** A dashboard: its name, and its widgets where they sit. */
const snapshotDashboardSchema = z
  .object({
    name: labelSchema,
    description: descriptionSchema.optional(),
    widgets: z.array(snapshotWidgetSchema).max(MAX_SNAPSHOT_WIDGETS),
    /**
     * The widgets the snapshot could not hold: those that read a table
     * that lives in a client's database, or a view only one person has.
     */
    left: z.int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

/** An id that stands for the table or the view a widget will read. */
const SOME_ID = "00000000-0000-4000-8000-000000000000";

/** A folder of tables: a name, and its place by its rank in the list. */
const snapshotFolderSchema = z.object({ name: labelSchema }).strict();

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
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(SNAPSHOT_VERSION),
      z.literal(SNAPSHOT_KEPT_VERSION),
    ]),
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
    /**
     * The folders the base keeps its tables in, in their order. Written
     * only for a base that has some: a base without folders gives the
     * snapshot it always gave.
     */
    folders: z.array(snapshotFolderSchema).max(MAX_SNAPSHOT_FOLDERS).optional(),
    /**
     * The base's dashboards, in their order. Written only for a base that
     * has some, as the folders are.
     */
    dashboards: z
      .array(snapshotDashboardSchema)
      .max(MAX_SNAPSHOT_DASHBOARDS)
      .optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    // A base names each dashboard once. A widget reads a table the
    // snapshot lists and, when it reads a view, one of that table's;
    // its settings are those of its kind, and name no id of another base.
    const dashboards = snapshot.dashboards ?? [];
    const views = new Map(
      snapshot.tables.map((table) => [table.key, table.views.length]),
    );
    const readable = dashboards.every((dashboard) =>
      dashboard.widgets.every((widget) => {
        const listed = views.get(widget.table);
        return (
          listed !== undefined &&
          (widget.view === undefined || widget.view < listed) &&
          !("tableId" in widget.config) &&
          !("viewId" in widget.config) &&
          dashboardWidgetConfigSchema.safeParse({
            kind: widget.kind,
            config: widgetConfigOn(
              widget.config,
              SOME_ID,
              widget.view === undefined ? undefined : SOME_ID,
            ),
          }).success
        );
      }),
    );
    if (
      !readable ||
      new Set(dashboards.map((dashboard) => dashboard.name)).size !==
        dashboards.length
    ) {
      context.addIssue({ code: "custom", message: "dashboards" });
    }
    // A table sits in a folder the snapshot lists, and a base names each
    // folder once.
    const folders = new Set(snapshot.folders?.map((folder) => folder.name));
    if (
      folders.size !== (snapshot.folders?.length ?? 0) ||
      snapshot.tables.some(
        (table) => table.folder !== undefined && !folders.has(table.folder),
      )
    ) {
      context.addIssue({ code: "custom", message: "folders" });
    }
    // Versions 3 and 4 keep their rows in their entries, versions 1 and 2
    // in the JSON: one place each, never both.
    const lines = snapshot.version >= SNAPSHOT_VERSION;
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

/**
 * The highest sequence number or place a file may give a row. A table goes
 * on from the highest number it holds, and every table's new rows from the
 * highest place: past this, they could soon take no new row.
 */
const MAX_LINE_NUMBER = BigInt(Number.MAX_SAFE_INTEGER);

/** Digits within that bound, read only once they are few enough to read. */
function withinLineNumbers(digits: string): boolean {
  return (
    digits.length <= 16 &&
    /^\d+$/.test(digits) &&
    BigInt(digits) <= MAX_LINE_NUMBER
  );
}

/** A row's sequence number and place, as a version 3 line names them. */
const lineSeqSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .refine(withinLineNumbers);
/** A number and a place as a table of this instance holds them. */
const ownLineSeqSchema = z.string().regex(/^[1-9]\d{0,18}$/);
const ownLinePositionSchema = z
  .string()
  .regex(/^-?\d{1,19}(?:\.\d{1,16000})?$/)
  .max(16_100);
const linePositionSchema = ownLinePositionSchema.refine((value) =>
  withinLineNumbers((value.split(".", 1)[0] ?? "").replace("-", "")),
);

/**
 * Where a version 4 line keeps its row's state: a key no field can be
 * named, so that it never stands for a cell.
 */
export const ROW_STATE_KEY = "@row";

/** An instant to the microsecond, in UTC, as the database gives it. */
const rowInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const rowAuthorSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .nullable();

/** What a row was when an instance copied it for itself (version 4). */
export const snapshotRowStateSchema = z
  .object({
    status: z.enum(["draft", "submitted", "locked", "signed"]),
    createdAt: rowInstantSchema,
    updatedAt: rowInstantSchema,
    createdBy: rowAuthorSchema,
    updatedBy: rowAuthorSchema,
  })
  .strict();

export type SnapshotRowState = z.infer<typeof snapshotRowStateSchema>;

/**
 * Where a line keeps the values of fields named like its own keys: a field
 * may be called `__seq` or `__position`, and is not the row's number.
 */
const LINE_FIELDS_KEY = "@fields";
const lineFieldsSchema = z
  .object({ __seq: cellSchema.optional(), __position: cellSchema.optional() })
  .strict();

/**
 * One row of a version 3 entry: its cells by column name, its sequence
 * number (`__seq`) and place (`__position`), and under each link's name the
 * sequence numbers of the rows it links to.
 */
export const snapshotLineSchema = z
  .object({
    __seq: lineSeqSchema,
    __position: linePositionSchema,
    [LINE_FIELDS_KEY]: lineFieldsSchema.optional(),
  })
  .catchall(cellSchema);

/**
 * A line of a copy the instance made of its own table: the row's number as
 * that table holds it and, in version 4, its state.
 */
export const ownSnapshotLineSchema = z
  .object({
    __seq: ownLineSeqSchema,
    __position: ownLinePositionSchema,
    [LINE_FIELDS_KEY]: lineFieldsSchema.optional(),
    [ROW_STATE_KEY]: snapshotRowStateSchema.optional(),
  })
  .catchall(cellSchema);

export type SnapshotLine = {
  __seq: string;
  __position: string;
  [key: string]: unknown;
};

/** A row as a line holds it: its number, place, state, and cells. */
export function writeSnapshotLine(input: {
  seq: string;
  position: string;
  cells: Readonly<Record<string, unknown>>;
  state?: SnapshotRowState | undefined;
}): SnapshotLine {
  const { __seq: seqField, __position: placeField, ...cells } = input.cells;
  const apart = {
    ...(seqField === undefined ? {} : { __seq: seqField }),
    ...(placeField === undefined ? {} : { __position: placeField }),
  };
  return {
    __seq: input.seq,
    __position: input.position,
    ...cells,
    ...(Object.keys(apart).length > 0 ? { [LINE_FIELDS_KEY]: apart } : {}),
    ...(input.state ? { [ROW_STATE_KEY]: input.state } : {}),
  };
}

/** A line's fields by name, those kept apart among them. */
export function snapshotLineCells(line: SnapshotLine): Record<string, unknown> {
  const {
    __seq: _seq,
    __position: _position,
    [ROW_STATE_KEY]: _state,
    [LINE_FIELDS_KEY]: apart,
    ...cells
  } = line;
  return { ...cells, ...(apart as Record<string, unknown> | undefined) };
}

/** One field of a line, by its name. */
export function snapshotLineField(line: SnapshotLine, name: string): unknown {
  if (name !== "__seq" && name !== "__position") return line[name];
  return (line[LINE_FIELDS_KEY] as Record<string, unknown> | undefined)?.[name];
}

/** The keys with which a row would say what state it is in. */
const ROW_STATE_CLAIMS = [
  ROW_STATE_KEY,
  "__status",
  "__created_at",
  "__updated_at",
  "__created_by",
  "__updated_by",
];

/**
 * Whether a row from a file says what state it is in, by a key that is none
 * of its table's fields. Only an instance's own copy is believed on that.
 */
export function claimsRowState(
  row: Readonly<Record<string, unknown>>,
  fields: ReadonlySet<string>,
): boolean {
  return ROW_STATE_CLAIMS.some(
    (key) => Object.hasOwn(row, key) && !fields.has(key),
  );
}

/** The rows a snapshot carries, in its JSON or in its entries. */
export function snapshotRowCount(snapshot: {
  tables: ReadonlyArray<{ rows?: readonly unknown[]; rowCount?: number }>;
}): number {
  return snapshot.tables.reduce(
    (sum, table) => sum + (table.rows?.length ?? table.rowCount ?? 0),
    0,
  );
}

/**
 * What a snapshot holds, for the person about to import it. Its members
 * are counted without that person: whoever imports a base owns it,
 * whatever role the file gave them, so they have none to be given back.
 */
export function snapshotSummary(
  snapshot: BaseSnapshot,
  importer: string,
): {
  name: string;
  tables: number;
  dashboards: number;
  rows: number;
  files: number;
  members: number;
} {
  const self = importer.toLowerCase();
  return {
    name: snapshot.base.name,
    tables: snapshot.tables.length,
    dashboards: snapshot.dashboards?.length ?? 0,
    rows: snapshotRowCount(snapshot),
    files: snapshot.files?.length ?? 0,
    members: (snapshot.members ?? []).filter(
      (member) => member.email.toLowerCase() !== self,
    ).length,
  };
}

export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type SnapshotFileRef = z.infer<typeof snapshotFileRefSchema>;
export type BaseSnapshot = z.infer<typeof baseSnapshotSchema>;
export type SnapshotTable = z.infer<typeof snapshotTableSchema>;
export type SnapshotLink = z.infer<typeof snapshotLinkSchema>;
export type SnapshotDashboard = z.infer<typeof snapshotDashboardSchema>;

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
