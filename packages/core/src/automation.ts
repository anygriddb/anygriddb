import { z } from "zod";
import { filterGroupSchema } from "./filter";
import { isTimeZone } from "./field-config";
import { columnNameSchema } from "./names";
import { AppError } from "./errors";

/** Actions at the top of an automation. */
export const MAX_AUTOMATION_ACTIONS = 20;
/** Actions inside one branch or one loop. */
export const MAX_NESTED_ACTIONS = 10;
/** Rows one loop goes through, at most. */
export const MAX_LOOP_ROWS = 100;

const templateSchema = z.string().max(10_000);
const valuesSchema = z
  .record(columnNameSchema, z.string().max(4_000))
  .refine((values) => Object.keys(values).length <= 50, {
    message: "Invalid automation",
  });

export const automationTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("row_created") }).strict(),
  z
    .object({
      type: z.literal("row_updated"),
      /** Only changes to these columns; none means any change. */
      columns: z.array(columnNameSchema).max(50).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("enters_filter"), filter: filterGroupSchema })
    .strict(),
  z
    .object({
      type: z.literal("form_submitted"),
      /** A form view of the table; any form when absent. */
      viewId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("schedule"),
      every: z.enum(["hour", "day", "week"]),
      /** `HH:MM` for daily and weekly runs; the minute is used hourly. */
      at: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default("09:00"),
      /** 0 is Sunday, for weekly runs. */
      weekday: z.int().min(0).max(6).optional(),
      timeZone: z.string().max(64).refine(isTimeZone, {
        message: "Invalid automation",
      }),
    })
    .strict(),
  z.object({ type: z.literal("button"), column: columnNameSchema }).strict(),
  /** After a row is deleted: its id, and its values where the trail has them. */
  z.object({ type: z.literal("row_deleted") }).strict(),
  /**
   * A call to the automation's secret address (`POST /hooks/automations/<token>`):
   * its JSON body's fields as `{{body_<field>}}`.
   */
  z.object({ type: z.literal("webhook") }).strict(),
]);

export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

/** An action that holds no other: what a branch or a loop runs. */
export const automationStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("update_record"), values: valuesSchema }).strict(),
  /** Deletes the row the run is about: the triggering one, or a loop's. */
  z.object({ type: z.literal("delete_record") }).strict(),
  z
    .object({
      type: z.literal("create_record"),
      tableId: z.uuid(),
      values: valuesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("send_email"),
      to: z.string().trim().min(1).max(500),
      subject: z.string().trim().min(1).max(200),
      body: templateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("call_webhook"),
      url: z
        .string()
        .trim()
        .max(500)
        .refine((value) => value.startsWith("https://"), {
          message: "Invalid automation",
        }),
      /** Sent as is after templating; a JSON summary of the row when absent. */
      body: templateSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("notify"),
      users: z.array(z.uuid()).min(1).max(20),
      message: z.string().trim().min(1).max(300),
    })
    .strict(),
]);

export type AutomationStep = z.infer<typeof automationStepSchema>;

const stepsSchema = (min: number) =>
  z.array(automationStepSchema).min(min).max(MAX_NESTED_ACTIONS);

export const automationActionSchema = z.union([
  automationStepSchema,
  /**
   * Runs `then` when the row matches `when`, `otherwise` when it does not:
   * the condition is a filter, read where the rows live.
   */
  z
    .object({
      type: z.literal("branch"),
      when: filterGroupSchema,
      then: stepsSchema(1),
      otherwise: stepsSchema(0).optional(),
    })
    .strict(),
  /**
   * Runs its actions for each row of a table of the base that `filter`
   * keeps, in order, `limit` rows at most: each action is about that row.
   */
  z
    .object({
      type: z.literal("for_each"),
      tableId: z.uuid(),
      filter: filterGroupSchema.optional(),
      limit: z.int().min(1).max(MAX_LOOP_ROWS).default(MAX_LOOP_ROWS),
      actions: stepsSchema(1),
    })
    .strict(),
]);

export type AutomationAction = z.infer<typeof automationActionSchema>;

/** Actions that need a row, which a run without one does not have. */
const ROW_ACTIONS = new Set<AutomationAction["type"]>([
  "update_record",
  "delete_record",
  "branch",
]);

/** Triggers that run without a row. */
const ROWLESS_TRIGGERS = new Set<AutomationTrigger["type"]>([
  "schedule",
  "webhook",
  "row_deleted",
]);

const automationShape = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  trigger: automationTriggerSchema,
  actions: z.array(automationActionSchema).min(1).max(MAX_AUTOMATION_ACTIONS),
};

function checkShape(
  input: { trigger: AutomationTrigger; actions: AutomationAction[] },
  context: z.RefinementCtx,
) {
  // A loop's actions have its row; the others need the trigger's.
  if (
    ROWLESS_TRIGGERS.has(input.trigger.type) &&
    input.actions.some((action) => ROW_ACTIONS.has(action.type))
  ) {
    context.addIssue({ code: "custom", message: "Invalid automation" });
  }
  if (
    input.trigger.type === "schedule" &&
    input.trigger.every === "week" &&
    input.trigger.weekday === undefined
  ) {
    context.addIssue({ code: "custom", message: "Invalid automation" });
  }
}

export const createAutomationInputSchema = z
  .object({ tableId: z.uuid(), ...automationShape })
  .superRefine(checkShape);

export const updateAutomationInputSchema = z
  .object({ automationId: z.uuid(), ...automationShape })
  .superRefine(checkShape);

/**
 * Replaces `{{key}}` with the matching value, as plain text. Nothing is
 * evaluated: an unknown key becomes an empty string.
 */
export function renderTemplate(
  source: string,
  values: Readonly<Record<string, string>>,
): string {
  return source.replace(
    /\{\{\s*([A-Za-z0-9_]{1,63})\s*\}\}/g,
    (_, key: string) => (Object.hasOwn(values, key) ? (values[key] ?? "") : ""),
  );
}

/** Keys a template reads, for validation and hints. */
export function templateKeys(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/\{\{\s*([A-Za-z0-9_]{1,63})\s*\}\}/g)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ];
}

/**
 * A webhook body's fields as template values: `body_<field>`, and one
 * level down `body_<field>_<inner>`, each as text; the whole body as
 * `body`. Keys keep their letters, digits, and underscores.
 */
export function webhookTemplateValues(body: unknown): Record<string, string> {
  const values: Record<string, string> = {
    body: JSON.stringify(body ?? null).slice(0, 10_000),
  };
  const key = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return value === null || value === undefined ? "" : JSON.stringify(value);
  };
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const fields = Object.entries(body as Record<string, unknown>);
    for (const [name, value] of fields.slice(0, 100)) {
      const outer = `body_${key(name)}`.slice(0, 63);
      values[outer] = text(value).slice(0, 4_000);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const inside = Object.entries(value as Record<string, unknown>);
        for (const [inner, nested] of inside.slice(0, 50)) {
          values[`${outer}_${key(inner)}`.slice(0, 63)] = text(nested).slice(
            0,
            4_000,
          );
        }
      }
    }
  }
  return values;
}

/** Keys every template may use besides column names. */
export const TEMPLATE_KEYS = [
  "record_id",
  "record_url",
  "table",
  "now",
] as const;

/** Minutes east of UTC for `timeZone` at `date`. */
function offsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** The instant a wall-clock time in `timeZone` happens. */
function zonedTime(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - offsetMinutes(timeZone, new Date(guess)) * 60_000;
  // A second pass settles times near a daylight saving change.
  return new Date(guess - offsetMinutes(timeZone, new Date(first)) * 60_000);
}

/** The first run of a schedule strictly after `after`. */
export function nextScheduleRun(
  trigger: Extract<AutomationTrigger, { type: "schedule" }>,
  after: Date,
): Date {
  const [hour = 9, minute = 0] = trigger.at.split(":").map(Number);
  if (trigger.every === "hour") {
    const next = new Date(after.getTime());
    next.setUTCSeconds(0, 0);
    // Hour offsets of real time zones are whole or half hours; the minute
    // is taken in the zone's own clock.
    const local = new Date(
      next.getTime() + offsetMinutes(trigger.timeZone, next) * 60_000,
    );
    local.setUTCMinutes(minute);
    let candidate = new Date(
      local.getTime() - offsetMinutes(trigger.timeZone, next) * 60_000,
    );
    while (candidate.getTime() <= after.getTime()) {
      candidate = new Date(candidate.getTime() + 60 * 60_000);
    }
    return candidate;
  }
  const local = new Date(
    after.getTime() + offsetMinutes(trigger.timeZone, after) * 60_000,
  );
  for (let days = 0; days <= 8; days += 1) {
    const day = new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() + days,
      ),
    );
    if (
      trigger.every === "week" &&
      day.getUTCDay() !== (trigger.weekday ?? 1)
    ) {
      continue;
    }
    const candidate = zonedTime(
      trigger.timeZone,
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hour,
      minute,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new AppError("invalid_automation");
}
