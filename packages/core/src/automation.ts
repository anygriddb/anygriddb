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
/** Characters of one script, at most. */
export const MAX_SCRIPT_LENGTH = 20_000;
/** Secrets one automation keeps for its scripts, at most. */
export const MAX_AUTOMATION_SECRETS = 10;

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
/** Where an action posts: an HTTPS address, checked again as public when it is saved and when it runs. */
const postAddressSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value.startsWith("https://"), {
    message: "Invalid automation",
  });

/** A message to a chat channel, before the row's values are put in it. */
const chatMessageSchema = z.string().trim().min(1).max(3_000);

const automationStepSchema = z.discriminatedUnion("type", [
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
      url: postAddressSchema,
      /** Sent as is after templating; a JSON summary of the row when absent. */
      body: templateSchema.optional(),
    })
    .strict(),
  // A message to a channel of Slack or Teams: the address of a webhook
  // the person made there, and a text with the row's values in it.
  z
    .object({
      type: z.literal("send_slack"),
      url: postAddressSchema,
      message: chatMessageSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("send_teams"),
      url: postAddressSchema,
      message: chatMessageSchema,
      /** The card's heading; none shows the message alone. */
      title: z.string().trim().max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("notify"),
      users: z.array(z.uuid()).min(1).max(20),
      message: z.string().trim().min(1).max(300),
    })
    .strict(),
  /**
   * Runs its author's JavaScript apart from the instance (ADR 0099). The
   * script reads `input`, reads and writes records with its author's
   * rights, and what it returns is `{{script_<key>}}` for the actions
   * after it.
   */
  z
    .object({
      type: z.literal("run_script"),
      code: z.string().min(1).max(MAX_SCRIPT_LENGTH),
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
      then: stepsSchema(1), // NOSONAR: a stored JSON key holding steps, never a function
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

/** A secret's name, as a script writes it: `{{secret.NAME}}`. */
const secretNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);

/** The one host a secret is sent to: a name, no port, no path. */
const secretHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

/**
 * A secret an automation keeps for its scripts (ADR 0101): sent only to
 * its host, in the place a script wrote its name. Its value is written
 * and never read back: absent, the one already kept stays.
 */
export const automationSecretInputSchema = z
  .object({
    name: secretNameSchema,
    host: secretHostSchema,
    value: z.string().min(1).max(4_000).optional(),
  })
  .strict();

export type AutomationSecretInput = z.infer<typeof automationSecretInputSchema>;

/** What is said of a secret: never its value. */
export type AutomationSecretInfo = {
  name: string;
  host: string;
  /** When its value was last set. */
  setAt: string;
};

const automationShape = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  trigger: automationTriggerSchema,
  actions: z.array(automationActionSchema).min(1).max(MAX_AUTOMATION_ACTIONS),
  /** The secrets to keep, by name; absent, they stay as they are. */
  secrets: z
    .array(automationSecretInputSchema)
    .max(MAX_AUTOMATION_SECRETS)
    .optional(),
};

function checkShape(
  input: {
    trigger: AutomationTrigger;
    actions: AutomationAction[];
    secrets?: AutomationSecretInput[] | undefined;
  },
  context: z.RefinementCtx,
) {
  const names = (input.secrets ?? []).map((secret) => secret.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "Invalid automation" });
  }
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

/** Whether an automation runs a script, at the top or inside a branch or a loop. */
export function hasScript(actions: readonly AutomationAction[]): boolean {
  const among = (list: readonly AutomationStep[]) =>
    list.some((step) => step.type === "run_script");
  return actions.some((action) => {
    if (action.type === "branch") {
      return among(action.then) || among(action.otherwise ?? []);
    }
    return action.type === "for_each" ? among(action.actions) : among([action]);
  });
}

/** Steps that send what they hold outside the instance. */
const SENDS_OUT = new Set<AutomationStep["type"]>([
  "send_email",
  "call_webhook",
  "send_slack",
  "send_teams",
  "run_script",
]);

/**
 * The tables an automation takes values out of, if it does: a step that
 * sends them outside the instance (a mail, a call, a channel's message, a
 * script), a row made in another table, or a loop over another table's
 * rows. Its author needs `data.export` on each, to save it and to run it.
 * Empty when its values stay where they are.
 */
export function tablesTakenOut(
  actions: readonly AutomationAction[],
  tableId: string,
): string[] {
  const loops = new Set<string>();
  let out = false;
  const visit = (list: readonly AutomationStep[]) => {
    for (const step of list) {
      if (SENDS_OUT.has(step.type)) out = true;
      if (step.type === "create_record" && step.tableId !== tableId) {
        out = true;
      }
    }
  };
  for (const action of actions) {
    if (action.type === "branch") {
      visit([...action.then, ...(action.otherwise ?? [])]);
    } else if (action.type === "for_each") {
      if (action.tableId !== tableId) {
        loops.add(action.tableId);
        out = true;
      }
      visit(action.actions);
    } else visit([action]);
  }
  return out ? [tableId, ...[...loops].filter((id) => id !== tableId)] : [];
}

/**
 * What a script returned, as template values for the actions after it:
 * `script_<key>` for each key of an object, `script_result` for anything
 * else, each as text. Keys keep their letters, digits, and underscores.
 */
export function scriptTemplateValues(output: unknown): Record<string, string> {
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return value === null || value === undefined ? "" : JSON.stringify(value);
  };
  if (output === null || output === undefined) return {};
  if (typeof output !== "object" || Array.isArray(output)) {
    return { script_result: text(output).slice(0, 4_000) };
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(output).slice(0, 50)) {
    const key = `script_${name.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 63);
    values[key] = text(value).slice(0, 4_000);
  }
  return values;
}

/** What a script writes where a secret goes: `{{secret.NAME}}`. */
const SECRET_PLACE = /\{\{\s*secret\.([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;

/** The secrets a text names, in the order it names them. */
export function secretNames(text: string): string[] {
  return [...text.matchAll(SECRET_PLACE)].map((match) => match[1] ?? "");
}

/**
 * Puts each secret where its name is written. A name `values` does not
 * hold is not a secret of this call: the answer says which one, and
 * nothing is filled.
 */
export function fillSecrets(
  text: string,
  values: ReadonlyMap<string, string>,
): { text: string } | { missing: string } {
  const missing = secretNames(text).find((name) => !values.has(name));
  if (missing !== undefined) return { missing };
  return {
    text: text.replace(
      SECRET_PLACE,
      (_, name: string) => values.get(name) ?? "",
    ),
  };
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

/** What a chat service shows of one message, however long the row's values make it. */
const CHAT_TEXT_MAX = 3_000;

/** The body Slack's incoming webhooks take: the text, and nothing else. */
export function writeSlackMessage(message: string): string {
  return JSON.stringify({ text: message.slice(0, CHAT_TEXT_MAX) });
}

/**
 * The body a Teams workflow takes when it posts what a webhook request
 * brings: a message holding one Adaptive Card. The connectors of before,
 * and their MessageCard, were retired by Microsoft in 2026.
 */
export function writeTeamsMessage(message: string, title?: string): string {
  const heading = title?.trim();
  return JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json", // NOSONAR: the card format's identifier, never fetched
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            ...(heading
              ? [
                  {
                    type: "TextBlock",
                    text: heading.slice(0, 200),
                    weight: "Bolder",
                    wrap: true,
                  },
                ]
              : []),
            {
              type: "TextBlock",
              text: message.slice(0, CHAT_TEXT_MAX),
              wrap: true,
            },
          ],
        },
      },
    ],
  });
}
