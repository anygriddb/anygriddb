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

function display(unit: LimitUnit, value: number): LimitEntry {
  return { unit, value, scope: "view", kind: "display", setBy: "code" };
}

export const LIMITS = {
  // Requests a client's address may send a minute, by kind (ADR 0009).
  "rate.auth": enforce("requests per minute", 20, "address"),
  "rate.oauth": enforce("requests per minute", 120, "address"),
  "rate.sign_on": enforce("requests per minute", 300, "address"),
  "rate.share": enforce("requests per minute", 240, "address"),
  "rate.api": enforce("requests per minute", 600, "address"),
  "rate.upload": enforce("requests per minute", 120, "address"),
  "rate.form_upload": enforce("requests per minute", 30, "address"),
  "rate.report": enforce("requests per minute", 30, "address"),
  "rate.app": enforce("requests per minute", 3_000, "address"),
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
