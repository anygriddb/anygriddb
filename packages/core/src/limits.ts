import { z } from "zod";

/**
 * Every ceiling the product keeps or shows, declared once (ADR 0132): what
 * it counts, how much by default, over what (an instance, an account, a
 * client's address…), whether it refuses or only says what it left out,
 * and where its value is set today. The code reads its ceilings from here;
 * a family of limits moves from the code to Administration, with its bounds
 * and its counters, one change at a time.
 */

/** What a limit counts. */
export type LimitUnit =
  | "requests per minute"
  | "runs per minute"
  | "minutes"
  | "hours"
  | "days"
  | "rows"
  | "bytes"
  | "jobs"
  | "sockets"
  | "channels"
  | "groups"
  | "actions"
  | "characters"
  | "secrets";

/** Over what a limit is counted. */
export type LimitScope =
  | "instance"
  | "account"
  | "address"
  | "automation"
  | "socket"
  | "request"
  | "view";

/**
 * A limit that refuses (or makes wait) what goes past it, or a ceiling a
 * screen keeps to and says so, still working.
 */
export type LimitKind = "enforce" | "display";

/**
 * Where the value is set today: fixed by the code, by the operator's
 * environment, or in Administration (the security policy, the instance's
 * settings).
 */
export type LimitSetBy = "code" | "environment" | "security" | "settings";

export type LimitEntry = {
  unit: LimitUnit;
  /** The value shipped, or the default an environment or a setting overrides. */
  value: number;
  scope: LimitScope;
  kind: LimitKind;
  setBy: LimitSetBy;
  /**
   * The least and the most an administrator may set, for a limit set in
   * Administration's "Limits and usage" (`setBy: "settings"`): the floor
   * still protects the instance, the top still protects the database.
   */
  bounds?: readonly [number, number];
};

const MIB = 1024 * 1024;

function enforce(
  unit: LimitUnit,
  value: number,
  scope: LimitScope,
  setBy: LimitSetBy = "code",
): LimitEntry {
  return { unit, value, scope, kind: "enforce", setBy };
}

/** A limit an administrator sets, between its bounds. */
type SettableEntry = LimitEntry & {
  setBy: "settings";
  bounds: readonly [number, number];
};

/** A rate an administrator may set, between its floor and its top. */
function rate(value: number, floor: number, top: number): SettableEntry {
  return {
    unit: "requests per minute",
    value,
    scope: "address",
    kind: "enforce",
    setBy: "settings",
    bounds: [floor, top],
  };
}

function display(unit: LimitUnit, value: number): LimitEntry {
  return { unit, value, scope: "view", kind: "display", setBy: "code" };
}

export const LIMITS = {
  // Requests a client's address may send a minute, by kind (ADR 0009).
  // Set in Administration, between the bounds ADR 0132 records.
  "rate.auth": rate(20, 5, 120),
  "rate.oauth": rate(120, 30, 1_200),
  "rate.sign_on": rate(300, 60, 3_000),
  "rate.share": rate(240, 60, 3_000),
  "rate.api": rate(600, 60, 6_000),
  "rate.upload": rate(120, 30, 1_200),
  "rate.form_upload": rate(30, 5, 300),
  "rate.report": rate(30, 5, 300),
  "rate.app": rate(3_000, 300, 30_000),
  // Jobs, sockets, an automation's pace.
  "jobs.active_per_account": enforce("jobs", 5, "account"),
  "jobs.retention_days": enforce("days", 7, "instance"),
  "export.file_hours": enforce("hours", 24, "instance"),
  "sockets.per_account": enforce("sockets", 64, "account"),
  "sockets.channels_per_socket": enforce("channels", 128, "socket"),
  "automation.runs_per_minute": enforce("runs per minute", 300, "automation"),
  "automation.max_delay_minutes": enforce("minutes", 24 * 60, "automation"),
  // Imports, exports, copies.
  "import.max_rows": enforce("rows", 1_000_000, "instance", "environment"),
  "export.max_rows": enforce("rows", 1_000_000, "instance", "environment"),
  "copy.max_rows": enforce("rows", 100_000, "request"),
  "import.text_bytes": enforce("bytes", 256 * MIB, "request"),
  "import.xlsx_bytes": enforce("bytes", 64 * MIB, "request"),
  "import.json_bytes": enforce("bytes", 20 * MIB, "request"),
  "attachment.max_bytes": enforce("bytes", 20 * MIB, "instance", "settings"),
  // Reads, and what a screen keeps to.
  "read.rows_per_page": enforce("rows", 1_000, "request"),
  "read.groups": enforce("groups", 2_000, "request"),
  "view.groups": enforce("groups", 5, "view"),
  "display.list_rows": display("rows", 5_000),
  "display.map_places": display("rows", 5_000),
  "display.calendar_rows": display("rows", 1_000),
  // What is kept, and for how long.
  "retention.notifications_read_days": enforce("days", 90, "instance"),
  "retention.notifications_unread_days": enforce("days", 180, "instance"),
  "retention.automation_runs_days": enforce("days", 30, "instance"),
  "retention.deliveries_days": enforce("days", 30, "instance"),
  "retention.digest_days": enforce("days", 30, "instance"),
  "retention.source_load_days": enforce("days", 30, "instance"),
  // An automation's shape.
  "automation.max_actions": enforce("actions", 20, "automation"),
  "automation.max_nested_actions": enforce("actions", 10, "automation"),
  "automation.max_loop_rows": enforce("rows", 100, "automation"),
  "automation.max_script_chars": enforce("characters", 20_000, "automation"),
  "automation.max_secrets": enforce("secrets", 10, "automation"),
} as const satisfies Record<string, LimitEntry>;

export type LimitId = keyof typeof LIMITS;

/** A limit's value as the code keeps it. */
export function ceilingOf(id: LimitId): number {
  if (!Object.hasOwn(LIMITS, id)) throw new Error(`no limit ${id}`);
  return LIMITS[id].value;
}

/** The limits an administrator sets, in Administration's "Limits and usage". */
export type SettableLimitId = {
  [Id in LimitId]: (typeof LIMITS)[Id] extends { setBy: "settings" }
    ? Id
    : never;
}[LimitId];

export const SETTABLE_LIMITS = (Object.keys(LIMITS) as LimitId[]).filter(
  (id): id is SettableLimitId => LIMITS[id].bounds !== undefined,
);

/**
 * What an administrator set, each value a whole number within its limit's
 * bounds; a limit left out keeps the catalogue's value.
 */
export const limitValuesSchema = z
  .object(
    Object.fromEntries(
      SETTABLE_LIMITS.map((id) => {
        const [floor, top] = LIMITS[id].bounds;
        return [id, z.int().min(floor).max(top).optional()];
      }),
    ) as Record<SettableLimitId, z.ZodOptional<z.ZodInt>>,
  )
  .strict();

export type LimitValues = z.output<typeof limitValuesSchema>;

/** A limit as the instance keeps it: as set, else the catalogue's value. */
export function limitIn(id: SettableLimitId, values: LimitValues): number {
  return values[id] ?? ceilingOf(id);
}
