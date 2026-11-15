import { z } from "zod";

/**
 * What the instance can tell a channel (ADR 0092). A caller emits one of
 * these and does not know which channels are configured. The payload
 * carries ids and codes, never an address, a row, or a secret.
 */
export const INSTANCE_EVENT_TYPES = [
  "job.failed",
  "job.succeeded",
  "backup.failed",
  "backup.succeeded",
  "import.failed",
  "datasource.unreachable",
  "datasource.recovered",
  "migration.failed",
  "disk.low",
  "auth.login_failed_burst",
  "user.created",
  "user.deleted",
  "integration.failing",
] as const;

export type InstanceEventType = (typeof INSTANCE_EVENT_TYPES)[number];

/** Checked when a channel is created. Success and account events stay off. */
export const DEFAULT_CHANNEL_EVENTS: readonly InstanceEventType[] = [
  "job.failed",
  "backup.failed",
  "datasource.unreachable",
  "migration.failed",
  "disk.low",
  "auth.login_failed_burst",
  "integration.failing",
];

const IMPORT_KINDS = new Set([
  "import",
  "import_snapshot",
  "import_airtable",
  "import_workbook",
]);

/**
 * A failed import is `import.failed` and not also `job.failed`, so a
 * channel subscribed to both does not get two messages for one job.
 */
export function jobEventType(
  kind: string,
  status: "failed" | "done",
): InstanceEventType | null {
  if (status === "done") return "job.succeeded";
  if (IMPORT_KINDS.has(kind)) return "import.failed";
  return "job.failed";
}

export const instanceEventFieldsSchema = z
  .record(
    z.string().regex(/^[a-z0-9_]{1,40}$/),
    z.union([z.string().max(200), z.number(), z.boolean()]),
  )
  .refine((fields) => Object.keys(fields).length <= 20, {
    message: "too many fields",
  });

export const instanceEventSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(INSTANCE_EVENT_TYPES),
    at: z.iso.datetime(),
    subject: z.string().min(1).max(200),
    fields: instanceEventFieldsSchema,
  })
  .strict();

export type InstanceEvent = z.infer<typeof instanceEventSchema>;

export type InstanceEventFields = z.infer<typeof instanceEventFieldsSchema>;

/** A short English description. Channels that show a sentence use this. */
export function instanceEventText(event: {
  type: string;
  subject: string;
  fields: InstanceEventFields;
}): { title: string; body: string } {
  const code = typeof event.fields.code === "string" ? event.fields.code : "";
  const kind = typeof event.fields.kind === "string" ? event.fields.kind : "";
  switch (event.type) {
    case "test":
      return {
        title: "AnyGridDB test",
        body: "This is a test from Administration. No action is needed.",
      };
    case "job.failed":
      return {
        title: "A background job failed",
        body: `Job ${event.subject} (${kind || "job"}) failed${code ? `: ${code}` : ""}.`,
      };
    case "job.succeeded":
      return {
        title: "A background job finished",
        body: `Job ${event.subject} (${kind || "job"}) finished.`,
      };
    case "backup.failed":
      return {
        title: "A backup failed",
        body: `Backup ${event.subject} failed${code ? `: ${code}` : ""}.`,
      };
    case "backup.succeeded":
      return {
        title: "A backup finished",
        body: `Backup ${event.subject} finished.`,
      };
    case "import.failed":
      return {
        title: "An import failed",
        body: `Import ${event.subject} (${kind || "import"}) failed${code ? `: ${code}` : ""}.`,
      };
    case "datasource.unreachable":
      return {
        title: "A source is unreachable",
        body: `Source ${event.subject} could not be reached.`,
      };
    case "datasource.recovered":
      return {
        title: "A source is reachable again",
        body: `Source ${event.subject} can be reached again.`,
      };
    case "migration.failed":
      return {
        title: "A database migration failed",
        body: `Migration ${event.subject} failed${code ? `: ${code}` : ""}.`,
      };
    case "disk.low": {
      const percent = event.fields.percent;
      const full =
        typeof percent === "number" ? ` (${String(percent)}% full)` : "";
      return {
        title: "Disk space is low",
        body: `The file volume is low on space${full}.`,
      };
    }
    case "auth.login_failed_burst":
      return {
        title: "An account was locked",
        body: `Account ${event.subject} was locked after repeated sign-in failures.`,
      };
    case "user.created":
      return {
        title: "An account was created",
        body: `Account ${event.subject} was created.`,
      };
    case "user.deleted":
      return {
        title: "An account was deleted",
        body: `Account ${event.subject} was deleted.`,
      };
    case "integration.failing":
      return {
        title: "An integration is failing",
        body: `Integration ${event.subject} has failed repeatedly and was paused.`,
      };
    default:
      return { title: "AnyGridDB", body: "An event was recorded." };
  }
}
