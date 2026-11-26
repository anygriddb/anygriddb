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
  | "secrets"
  | "milliseconds"
  | "seconds"
  | "attempts"
  | "items"
  | "levels"
  | "accounts"
  | "bases"
  | "mebibytes";

/** Over what a limit is counted. */
export type LimitScope =
  | "instance"
  | "account"
  | "address"
  | "automation"
  | "socket"
  | "request"
  | "view"
  | "channel"
  | "session"
  | "link"
  | "file"
  | "cell"
  | "base";

/**
 * A limit that refuses (or makes wait) what goes past it, or a ceiling a
 * screen keeps to and says so, still working.
 */
export type LimitKind = "enforce" | "display";

/**
 * Where the value is set today: fixed by the code, by what an exchange is
 * (`protocol`: a link's, a code's, a challenge's life, never changed), by
 * the operator's environment, or in Administration (the security policy, the instance's
 * settings, or "Limits and usage" itself). A limit set in "Limits and
 * usage" that the environment may fix names its variable (`fixedBy`): set
 * there, it wins (ADR 0083).
 */
export type LimitSetBy =
  "code" | "environment" | "security" | "settings" | "limits" | "protocol";

export type LimitEntry = {
  unit: LimitUnit;
  /** The value shipped, or the default an environment or a setting overrides. */
  value: number;
  scope: LimitScope;
  kind: LimitKind;
  setBy: LimitSetBy;
  /**
   * The least and the most an administrator may set, for a limit set in
   * Administration ("Limits and usage", `setBy: "limits"`, or Settings and
   * Security): the floor still protects the instance, the top still
   * protects the database.
   */
  bounds?: readonly [number, number];
  /** The environment's variable that fixes it over Administration, when set. */
  fixedBy?: "IMPORT_MAX_ROWS" | "EXPORT_MAX_ROWS";
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

/** A limit an administrator sets in "Limits and usage", between its bounds. */
type SettableEntry = LimitEntry & {
  setBy: "limits";
  bounds: readonly [number, number];
};

/** A limit an administrator may set, between its floor and its top. */
function settable(
  unit: LimitUnit,
  value: number,
  scope: LimitScope,
  floor: number,
  top: number,
): SettableEntry {
  return {
    unit,
    value,
    scope,
    kind: "enforce",
    setBy: "limits",
    bounds: [floor, top],
  };
}

/** A rate of requests a client's address may send, between its bounds. */
function rate(value: number, floor: number, top: number): SettableEntry {
  return settable("requests per minute", value, "address", floor, top);
}

/** A limit set in Settings or Security, between its bounds. */
function kept(
  value: number,
  floor: number,
  top: number,
  setBy: "settings" | "security",
): LimitEntry & { bounds: readonly [number, number] } {
  return {
    unit: "days",
    value,
    scope: "instance",
    kind: "enforce",
    setBy,
    bounds: [floor, top],
  };
}

/**
 * The rows one file brings in, or one job writes out, at most: set in
 * "Limits and usage" unless the environment fixes it.
 */
function rows(fixedBy: "IMPORT_MAX_ROWS" | "EXPORT_MAX_ROWS"): SettableEntry {
  return {
    ...settable("rows", 1_000_000, "instance", 100_000, 10_000_000),
    fixedBy,
  };
}

function display(unit: LimitUnit, value: number): LimitEntry {
  return { unit, value, scope: "view", kind: "display", setBy: "code" };
}

/** A limit the code keeps, or a protocol's fixed duration. */
function fixed(
  unit: LimitUnit,
  value: number,
  scope: LimitScope,
  setBy: "code" | "protocol" = "code",
  kind: LimitKind = "enforce",
): LimitEntry {
  return { unit, value, scope, kind, setBy };
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
  // Set in Administration, between the bounds ADR 0132 records.
  "jobs.active_per_account": settable("jobs", 5, "account", 1, 50),
  "jobs.retention_days": settable("days", 7, "instance", 1, 90),
  "export.file_hours": settable("hours", 24, "instance", 1, 168),
  "sockets.per_account": settable("sockets", 64, "account", 4, 256),
  "sockets.channels_per_socket": enforce("channels", 128, "socket"),
  "automation.runs_per_minute": settable(
    "runs per minute",
    300,
    "automation",
    30,
    3_000,
  ),
  "automation.max_delay_minutes": settable(
    "minutes",
    24 * 60,
    "automation",
    60,
    7 * 24 * 60,
  ),
  // What files a base and an account may hold, 0 for no quota (ADR 0136).
  // Set in Administration, up to a tebibyte.
  "storage.base_bytes": settable("bytes", 0, "base", 0, 1024 ** 4),
  "storage.account_bytes": settable("bytes", 0, "account", 0, 1024 ** 4),
  // Imports, exports, copies.
  "import.max_rows": rows("IMPORT_MAX_ROWS"),
  "export.max_rows": rows("EXPORT_MAX_ROWS"),
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
  // Set in Settings and Security, between their bounds.
  "retention.trash_days": kept(30, 7, 365, "settings"),
  "retention.restore_point_days": kept(30, 1, 365, "settings"),
  "retention.sign_in_days": kept(365, 180, 365, "security"),
  // An automation's shape.
  "automation.max_actions": enforce("actions", 20, "automation"),
  "automation.max_nested_actions": enforce("actions", 10, "automation"),
  "automation.max_loop_rows": enforce("rows", 100, "automation"),
  "automation.max_script_chars": enforce("characters", 20_000, "automation"),
  "automation.max_secrets": enforce("secrets", 10, "automation"),
  // More of the work in the background and live connections.
  "alerts.reminder_hours": fixed("hours", 24, "instance"),
  "sockets.message_chars": fixed("characters", 16_384, "socket"),
  "sockets.buffered_bytes": fixed("bytes", 1_048_576, "socket"),
  "sockets.queued_messages": fixed("items", 256, "socket"),
  "sockets.early_messages": fixed("items", 64, "socket"),
  // More of files, imports and snapshots.
  "export.account_list_rows": fixed("rows", 10_000, "account"),
  "export.csv_chars": fixed("characters", 8_000_000, "request"),
  "import.errors_listed": fixed("items", 200, "view", "code", "display"),
  "import.options_added": fixed("items", 200, "request"),
  "logo.bytes": fixed("bytes", 262_144, "instance"),
  "snapshot.link_pairs": fixed("items", 5000, "request"),
  "snapshot.rows": fixed("rows", 100_000, "file"),
  "snapshot.line_bytes": fixed("bytes", 4_194_304, "file"),
  "snapshot.tables": fixed("items", 100, "file"),
  "snapshot.folders": fixed("items", 500, "file"),
  "snapshot.bytes": fixed("bytes", 41_943_040, "file"),
  "snapshot.archive_bytes": fixed("bytes", 2_147_483_648, "file"),
  "snapshot.files": fixed("items", 50_000, "file"),
  "snapshot.comments": fixed("items", 1_000_000, "file"),
  "snapshot.dashboards": fixed("items", 500, "file"),
  "snapshot.widgets": fixed("items", 500, "file"),
  "attachment.max_bytes_top": fixed("bytes", 524_288_000, "instance"),
  // More of what a page reads and shows.
  "widget.rows": fixed("rows", 20, "view", "code", "display"),
  "comments.listed": fixed("items", 500, "request"),
  "chart.series": fixed("items", 8, "view", "code", "display"),
  "chart.categories": fixed("items", 40, "view", "code", "display"),
  "api.records_per_call": fixed("rows", 100, "request"),
  "request.input_depth": fixed("levels", 128, "request"),
  "read.offset": fixed("rows", 10_000_000, "request"),
  "chart.histogram_bins": fixed("items", 40, "view", "code", "display"),
  "display.table_activity": fixed("items", 8, "view", "code", "display"),
  // What a cell, a formula, a filter and a view hold.
  "formula.lookup_hops": fixed("levels", 15, "request"),
  "conversion.options_added": fixed("items", 200, "request"),
  "grid.series_rows": fixed("rows", 1000, "request"),
  "cell.place_chars": fixed("characters", 64, "cell"),
  "cell.list_items": fixed("items", 100, "cell"),
  "cell.files": fixed("items", 20, "cell"),
  "filter.depth": fixed("levels", 5, "view"),
  "filter.conditions": fixed("items", 100, "view"),
  "formula.nodes": fixed("items", 500, "request"),
  "formula.depth": fixed("levels", 40, "request"),
  "formula.source_chars": fixed("characters", 4000, "request"),
  "formula.repeat_chars": fixed("characters", 10_000, "cell"),
  "formula.sql_chars": fixed("characters", 1_000_000, "request"),
  "formula.json_path_steps": fixed("items", 32, "request"),
  "formula.computed_chars": fixed("characters", 100_000, "cell"),
  "cell.json_chars": fixed("characters", 20_000, "cell"),
  "cell.json_depth": fixed("levels", 100, "cell"),
  "comments.mentions": fixed("items", 20, "request"),
  "write.rows_per_call": fixed("rows", 500, "request"),
  "write.links_per_cell": fixed("items", 500, "cell"),
  "view.sorts": fixed("items", 10, "view"),
  "view.frozen_fields": fixed("items", 10, "view"),
  // Signing in, codes and links; a protocol's durations never change.
  "auth.second_factor_attempts": fixed("attempts", 5, "session"),
  "auth.email_code_attempts": fixed("attempts", 5, "session"),
  "auth.email_codes_per_hour": fixed("items", 5, "account"),
  "auth.pending_sign_ups": fixed("items", 3, "address"),
  "auth.waiting_guesses": fixed("items", 4, "account"),
  "link.password_attempts": fixed("attempts", 10, "link"),
  "link.lock_minutes": fixed("minutes", 15, "link"),
  "protocol.second_factor_ms": fixed(
    "milliseconds",
    300_000,
    "session",
    "protocol",
  ),
  "protocol.email_code_ms": fixed(
    "milliseconds",
    600_000,
    "session",
    "protocol",
  ),
  "protocol.email_code_gap_ms": fixed(
    "milliseconds",
    60_000,
    "account",
    "protocol",
  ),
  "protocol.sign_on_state_ms": fixed(
    "milliseconds",
    600_000,
    "session",
    "protocol",
  ),
  "protocol.provider_discovery_ms": fixed(
    "milliseconds",
    3_600_000,
    "instance",
    "protocol",
  ),
  "protocol.erase_sign_in_ms": fixed(
    "milliseconds",
    600_000,
    "session",
    "protocol",
  ),
  "protocol.install_token_ms": fixed(
    "milliseconds",
    3_600_000,
    "instance",
    "protocol",
  ),
  "protocol.reset_link_ms": fixed(
    "milliseconds",
    3_600_000,
    "account",
    "protocol",
  ),
  "protocol.admin_reset_link_ms": fixed(
    "milliseconds",
    86_400_000,
    "account",
    "protocol",
  ),
  "protocol.account_link_ms": fixed(
    "milliseconds",
    604_800_000,
    "account",
    "protocol",
  ),
  "protocol.saml_request_ms": fixed(
    "milliseconds",
    600_000,
    "session",
    "protocol",
  ),
  "protocol.sign_up_link_ms": fixed(
    "milliseconds",
    86_400_000,
    "address",
    "protocol",
  ),
  "protocol.proof_ms": fixed("milliseconds", 300_000, "session", "protocol"),
  "protocol.token_days": fixed("days", 30, "account", "protocol"),
  "protocol.totp_step_ms": fixed("milliseconds", 30_000, "session", "protocol"),
  "protocol.passkey_ms": fixed("milliseconds", 300_000, "session", "protocol"),
  "protocol.logout_token_chars": fixed(
    "characters",
    8192,
    "request",
    "protocol",
  ),
  "protocol.logout_token_seconds": fixed("seconds", 300, "request", "protocol"),
  "protocol.sign_on_again_seconds": fixed(
    "seconds",
    2_592_000,
    "session",
    "protocol",
  ),
  "protocol.acting_as_ms": fixed(
    "milliseconds",
    1_800_000,
    "session",
    "protocol",
  ),
  "protocol.base_opening_minutes": fixed("minutes", 60, "session", "protocol"),
  "protocol.invitation_ms": fixed(
    "milliseconds",
    1_209_600_000,
    "address",
    "protocol",
  ),
  "protocol.link_unlocked_ms": fixed(
    "milliseconds",
    43_200_000,
    "link",
    "protocol",
  ),
  "protocol.oauth_code_ms": fixed(
    "milliseconds",
    600_000,
    "request",
    "protocol",
  ),
  "protocol.oauth_refresh_days": fixed("days", 90, "account", "protocol"),
  "protocol.admin_lock_minutes": fixed("minutes", 60, "account", "protocol"),
  "link.embed_origins": fixed("items", 20, "link"),
  // Channels, directories, stores read by copy, and calls out.
  "sync.max_rows": fixed("rows", 1_000_000, "instance"),
  "webhook.failures_before_off": fixed("attempts", 10, "channel"),
  "channel.failures_before_pause": fixed("attempts", 5, "channel"),
  "channel.deliveries_per_window": fixed("items", 20, "channel"),
  "channel.rate_window_ms": fixed("milliseconds", 3_600_000, "channel"),
  "channel.same_subject_ms": fixed("milliseconds", 300_000, "channel"),
  "channel.per_instance": fixed("channels", 50, "instance"),
  "scim.page_rows": fixed("rows", 200, "request"),
  "scim.group_members": fixed("accounts", 10_000, "request"),
  "accounts.bulk": fixed("accounts", 100, "request"),
  "people.file_rows": fixed("rows", 200, "file"),
  "people.file_bytes": fixed("bytes", 256_000, "file"),
  "people.file_bases": fixed("bases", 20, "file"),
  "notice.recipients": fixed("accounts", 500, "request"),
  "notice.subject_chars": fixed("characters", 200, "request"),
  "notice.body_chars": fixed("characters", 5000, "request"),
  "notice.per_hour": fixed("items", 5, "instance"),
  "copy.answer_bytes": fixed("bytes", 268_435_456, "request"),
  "copy.collections_listed": fixed("items", 1000, "instance"),
  "copy.fields_read": fixed("items", 300, "request"),
  "copy.indices_listed": fixed("items", 1000, "instance"),
  "source.tables_listed": fixed("items", 2000, "instance"),
  "timeout.mcp_call_ms": fixed("milliseconds", 60_000, "request"),
  "timeout.object_store_ms": fixed("milliseconds", 60_000, "request"),
  "timeout.object_store_connect_ms": fixed("milliseconds", 10_000, "request"),
  "timeout.outbound_ms": fixed("milliseconds", 10_000, "request"),
  "timeout.provider_ms": fixed("milliseconds", 10_000, "request"),
  "timeout.syslog_ms": fixed("milliseconds", 5000, "request"),
  "timeout.release_check_ms": fixed("milliseconds", 10_000, "request"),
  "timeout.import_call_ms": fixed("milliseconds", 30_000, "request"),
  "timeout.client_status_fence_ms": fixed("milliseconds", 300_000, "request"),
  "timeout.first_bytes_ms": fixed("milliseconds", 10_000, "request"),
  // More of what is kept, and for how long.
  "retention.closed_alerts_days": fixed("days", 90, "instance"),
  "retention.backup_runs_days": fixed("days", 400, "instance"),
  "retention.staged_file_hours": fixed("hours", 24, "instance"),
  "trail.table_open_hours": fixed("hours", 1, "account"),
  "logs.lines_kept": fixed("items", 500, "instance"),
  "logs.bytes_kept": fixed("bytes", 524_288, "instance"),
  "restore.points_per_base": fixed("items", 20, "instance"),
  "retention.staged_import_seconds": fixed("seconds", 1800, "request"),
  "retention.queued_import_seconds": fixed("seconds", 7200, "request"),
  "retention.staged_workbook_seconds": fixed("seconds", 1800, "request"),
  "retention.queued_workbook_seconds": fixed("seconds", 7200, "request"),
  "retention.parse_folder_ms": fixed("milliseconds", 3_600_000, "instance"),
  // More of an automation's shape.
  "automation.script_log_lines": fixed("items", 50, "automation"),
  "automation.script_log_chars": fixed("characters", 500, "automation"),
  "automation.script_error_chars": fixed("characters", 300, "automation"),
  "automation.email_recipients": fixed("items", 10, "automation"),
  "automation.event_depth": fixed("levels", 3, "automation"),
  "automation.script_answer_bytes": fixed("bytes", 1_048_576, "automation"),
  // The last ceilings found outside the catalogue.
  "import.call_answer_bytes": fixed("bytes", 16_777_216, "request"),
  "release.answer_bytes": fixed("bytes", 1_048_576, "request"),
  "feed.past_days": fixed("days", 183, "view"),
  "feed.future_days": fixed("days", 731, "view"),
  "retention.staged_snapshot_seconds": fixed("seconds", 1800, "request"),
  "retention.queued_snapshot_seconds": fixed("seconds", 7200, "request"),
  "usage.active_days": fixed("days", 30, "view", "code", "display"),
  "usage.trend_days": fixed("days", 90, "view", "code", "display"),
  "auth.acting_reason_chars": fixed("characters", 200, "session"),
  "import.field_name_chars": fixed("characters", 100, "file"),
  "request.link_calls": fixed("items", 10, "request"),
  "copy.id_chars": fixed("characters", 500, "request"),
  "automation.script_time_ms": fixed("milliseconds", 10_000, "automation"),
  "automation.script_run_ms": fixed("milliseconds", 60_000, "automation"),
  "automation.script_memory_bytes": fixed("bytes", 67_108_864, "automation"),
  "automation.script_calls": fixed("items", 100, "automation"),
  "automation.script_call_bytes": fixed("bytes", 262_144, "automation"),
  "automation.script_reply_bytes": fixed("bytes", 4_194_304, "automation"),
  "automation.script_output_bytes": fixed("bytes", 65_536, "automation"),
  "automation.script_heap_mb": fixed("mebibytes", 128, "automation"),
  "automation.script_start_ms": fixed("milliseconds", 10_000, "automation"),
  "automation.script_grace_ms": fixed("milliseconds", 2000, "automation"),
  "import.parse_heap_mb": fixed("mebibytes", 512, "file"),
  "import.scan_ms": fixed("milliseconds", 300_000, "file"),
  "import.batch_ms": fixed("milliseconds", 60_000, "file"),
  "import.zip_entries": fixed("items", 2000, "file"),
  "import.zip_entry_bytes": fixed("bytes", 1_073_741_824, "file"),
  "import.zip_total_bytes": fixed("bytes", 2_147_483_648, "file"),
} as const satisfies Record<string, LimitEntry>;

export type LimitId = keyof typeof LIMITS;

/** A limit's value as the code keeps it. */
export function ceilingOf(id: LimitId): number {
  if (!Object.hasOwn(LIMITS, id)) throw new Error(`no limit ${id}`);
  return LIMITS[id].value;
}

/** The limits an administrator sets, in Administration's "Limits and usage". */
export type SettableLimitId = {
  [Id in LimitId]: (typeof LIMITS)[Id] extends { setBy: "limits" } ? Id : never;
}[LimitId];

export const SETTABLE_LIMITS = (Object.keys(LIMITS) as LimitId[]).filter(
  (id): id is SettableLimitId => LIMITS[id].setBy === "limits",
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

/** A bounded limit's least and most, as a settings schema takes them. */
export function boundsOf(
  id:
    | "retention.trash_days"
    | "retention.restore_point_days"
    | "retention.sign_in_days",
): { min: number; max: number } {
  const [min, max] = LIMITS[id].bounds;
  return { min, max };
}

/** A limit as the instance keeps it: as set, else the catalogue's value. */
export function limitIn(id: SettableLimitId, values: LimitValues): number {
  return values[id] ?? ceilingOf(id);
}
