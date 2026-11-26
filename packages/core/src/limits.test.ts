import { describe, expect, it } from "vitest";
import { MAX_AUTOMATION_ACTIONS } from "./automation";
import {
  ceilingOf,
  limitIn,
  LIMITS,
  limitValuesSchema,
  SETTABLE_LIMITS,
} from "./limits";
import {
  INSTANCE_DEFAULTS,
  parseInstanceSettings,
  POLICY_BOUNDS,
} from "./instance";
import { MAX_READ_LIMIT } from "./query/read";

describe("the catalogue of limits", () => {
  it("holds each ceiling once, at the value ADR 0132 records", () => {
    expect(
      Object.fromEntries(
        Object.entries(LIMITS).map(([id, entry]) => [id, entry.value]),
      ),
    ).toEqual({
      "import.call_answer_bytes": 16_777_216,
      "release.answer_bytes": 1_048_576,
      "feed.past_days": 183,
      "feed.future_days": 731,
      "retention.staged_snapshot_seconds": 1800,
      "retention.queued_snapshot_seconds": 7200,
      "usage.active_days": 30,
      "usage.trend_days": 90,
      "auth.acting_reason_chars": 200,
      "import.field_name_chars": 100,
      "request.link_calls": 10,
      "copy.id_chars": 500,
      "automation.script_time_ms": 10_000,
      "automation.script_run_ms": 60_000,
      "automation.script_memory_bytes": 67_108_864,
      "automation.script_calls": 100,
      "automation.script_call_bytes": 262_144,
      "automation.script_reply_bytes": 4_194_304,
      "automation.script_output_bytes": 65_536,
      "automation.script_heap_mb": 128,
      "automation.script_start_ms": 10_000,
      "automation.script_grace_ms": 2000,
      "import.parse_heap_mb": 512,
      "import.scan_ms": 300_000,
      "import.batch_ms": 60_000,
      "import.zip_entries": 2000,
      "import.zip_entry_bytes": 1_073_741_824,
      "import.zip_total_bytes": 2_147_483_648,
      "sync.max_rows": 1_000_000,
      "webhook.failures_before_off": 10,
      "channel.failures_before_pause": 5,
      "channel.deliveries_per_window": 20,
      "channel.rate_window_ms": 3_600_000,
      "channel.same_subject_ms": 300_000,
      "channel.per_instance": 50,
      "scim.page_rows": 200,
      "scim.group_members": 10_000,
      "accounts.bulk": 100,
      "people.file_rows": 200,
      "people.file_bytes": 256_000,
      "people.file_bases": 20,
      "widget.rows": 20,
      "retention.closed_alerts_days": 90,
      "retention.backup_runs_days": 400,
      "export.account_list_rows": 10_000,
      "auth.second_factor_attempts": 5,
      "auth.email_code_attempts": 5,
      "auth.email_codes_per_hour": 5,
      "auth.pending_sign_ups": 3,
      "auth.waiting_guesses": 4,
      "link.password_attempts": 10,
      "link.lock_minutes": 15,
      "protocol.second_factor_ms": 300_000,
      "protocol.email_code_ms": 600_000,
      "protocol.email_code_gap_ms": 60_000,
      "protocol.sign_on_state_ms": 600_000,
      "protocol.provider_discovery_ms": 3_600_000,
      "protocol.erase_sign_in_ms": 600_000,
      "protocol.install_token_ms": 3_600_000,
      "protocol.reset_link_ms": 3_600_000,
      "protocol.admin_reset_link_ms": 86_400_000,
      "protocol.account_link_ms": 604_800_000,
      "protocol.saml_request_ms": 600_000,
      "protocol.sign_up_link_ms": 86_400_000,
      "protocol.proof_ms": 300_000,
      "protocol.token_days": 30,
      "protocol.totp_step_ms": 30_000,
      "protocol.passkey_ms": 300_000,
      "protocol.logout_token_chars": 8192,
      "protocol.logout_token_seconds": 300,
      "protocol.sign_on_again_seconds": 2_592_000,
      "protocol.acting_as_ms": 1_800_000,
      "protocol.base_opening_minutes": 60,
      "protocol.invitation_ms": 1_209_600_000,
      "protocol.link_unlocked_ms": 43_200_000,
      "protocol.oauth_code_ms": 600_000,
      "protocol.oauth_refresh_days": 90,
      "protocol.admin_lock_minutes": 60,
      "alerts.reminder_hours": 24,
      "retention.staged_file_hours": 24,
      "trail.table_open_hours": 1,
      "automation.script_log_lines": 50,
      "automation.script_log_chars": 500,
      "automation.script_error_chars": 300,
      "automation.email_recipients": 10,
      "automation.event_depth": 3,
      "comments.listed": 500,
      "chart.series": 8,
      "chart.categories": 40,
      "formula.lookup_hops": 15,
      "export.csv_chars": 8_000_000,
      "import.errors_listed": 200,
      "import.options_added": 200,
      "conversion.options_added": 200,
      "notice.recipients": 500,
      "notice.subject_chars": 200,
      "notice.body_chars": 5000,
      "notice.per_hour": 5,
      "logs.lines_kept": 500,
      "logs.bytes_kept": 524_288,
      "api.records_per_call": 100,
      "sockets.message_chars": 16_384,
      "sockets.buffered_bytes": 1_048_576,
      "sockets.queued_messages": 256,
      "sockets.early_messages": 64,
      "copy.answer_bytes": 268_435_456,
      "copy.collections_listed": 1000,
      "copy.fields_read": 300,
      "copy.indices_listed": 1000,
      "source.tables_listed": 2000,
      "request.input_depth": 128,
      "grid.series_rows": 1000,
      "cell.place_chars": 64,
      "cell.list_items": 100,
      "cell.files": 20,
      "link.embed_origins": 20,
      "filter.depth": 5,
      "filter.conditions": 100,
      "formula.nodes": 500,
      "formula.depth": 40,
      "formula.source_chars": 4000,
      "formula.repeat_chars": 10_000,
      "formula.sql_chars": 1_000_000,
      "formula.json_path_steps": 32,
      "read.offset": 10_000_000,
      "formula.computed_chars": 100_000,
      "chart.histogram_bins": 40,
      "logo.bytes": 262_144,
      "cell.json_chars": 20_000,
      "cell.json_depth": 100,
      "comments.mentions": 20,
      "snapshot.link_pairs": 5000,
      "write.rows_per_call": 500,
      "restore.points_per_base": 20,
      "write.links_per_cell": 500,
      "display.table_activity": 8,
      "snapshot.rows": 100_000,
      "snapshot.line_bytes": 4_194_304,
      "snapshot.tables": 100,
      "snapshot.folders": 500,
      "snapshot.bytes": 41_943_040,
      "snapshot.archive_bytes": 2_147_483_648,
      "snapshot.files": 50_000,
      "snapshot.comments": 1_000_000,
      "snapshot.dashboards": 500,
      "snapshot.widgets": 500,
      "view.sorts": 10,
      "view.frozen_fields": 10,
      "attachment.max_bytes_top": 524_288_000,
      "timeout.mcp_call_ms": 60_000,
      "timeout.object_store_ms": 60_000,
      "timeout.object_store_connect_ms": 10_000,
      "timeout.outbound_ms": 10_000,
      "timeout.provider_ms": 10_000,
      "timeout.syslog_ms": 5000,
      "timeout.release_check_ms": 10_000,
      "timeout.import_call_ms": 30_000,
      "timeout.client_status_fence_ms": 300_000,
      "timeout.first_bytes_ms": 10_000,
      "retention.staged_import_seconds": 1800,
      "retention.queued_import_seconds": 7200,
      "retention.staged_workbook_seconds": 1800,
      "retention.queued_workbook_seconds": 7200,
      "retention.parse_folder_ms": 3_600_000,
      "automation.script_answer_bytes": 1_048_576,
      "attachment.max_bytes": 20_971_520,
      "automation.max_actions": 20,
      "automation.max_delay_minutes": 1_440,
      "automation.max_loop_rows": 100,
      "automation.max_nested_actions": 10,
      "automation.max_script_chars": 20_000,
      "automation.max_secrets": 10,
      "automation.runs_per_minute": 300,
      "copy.max_rows": 100_000,
      "display.calendar_rows": 1_000,
      "display.list_rows": 5_000,
      "display.map_places": 5_000,
      "export.file_hours": 24,
      "export.max_rows": 1_000_000,
      "import.json_bytes": 20_971_520,
      "import.max_rows": 1_000_000,
      "import.text_bytes": 268_435_456,
      "import.xlsx_bytes": 67_108_864,
      "jobs.active_per_account": 5,
      "jobs.retention_days": 7,
      "rate.api": 600,
      "rate.app": 3_000,
      "rate.auth": 20,
      "rate.form_upload": 30,
      "rate.oauth": 120,
      "rate.report": 30,
      "rate.share": 240,
      "rate.sign_on": 300,
      "rate.upload": 120,
      "read.groups": 2_000,
      "read.rows_per_page": 1_000,
      "retention.automation_runs_days": 30,
      "retention.deliveries_days": 30,
      "retention.digest_days": 30,
      "retention.notifications_read_days": 90,
      "retention.notifications_unread_days": 180,
      "retention.restore_point_days": 30,
      "retention.sign_in_days": 365,
      "retention.source_load_days": 30,
      "retention.trash_days": 30,
      "sockets.channels_per_socket": 128,
      "sockets.per_account": 64,
      "view.groups": 5,
    });
  });

  it("names each limit as a family and a ceiling, each a positive whole number", () => {
    for (const [id, entry] of Object.entries(LIMITS)) {
      expect(id, id).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(Number.isInteger(entry.value) && entry.value > 0, id).toBe(true);
      // What a screen keeps to never refuses: it says what it left out.
      if (entry.kind === "display") expect(entry.scope, id).toBe("view");
    }
  });

  it("is what the code reads, and nothing else", () => {
    expect(MAX_READ_LIMIT).toBe(ceilingOf("read.rows_per_page"));
    expect(MAX_AUTOMATION_ACTIONS).toBe(ceilingOf("automation.max_actions"));
    // A ceiling the catalogue does not hold is no ceiling.
    expect(() => ceilingOf("nonsense" as never)).toThrow();
  });
});

describe("the days kept that Settings and Security set", () => {
  it("are the settings' own bounds and defaults", () => {
    expect(POLICY_BOUNDS.trashDays).toEqual({ min: 7, max: 365 });
    expect(POLICY_BOUNDS.restorePointDays).toEqual({ min: 1, max: 365 });
    expect(POLICY_BOUNDS.authRetentionDays).toEqual({ min: 180, max: 365 });
    expect(INSTANCE_DEFAULTS.trashDays).toBe(ceilingOf("retention.trash_days"));
    expect(INSTANCE_DEFAULTS.authRetentionDays).toBe(
      ceilingOf("retention.sign_in_days"),
    );
  });

  it("are not set in Limits and usage", () => {
    expect(
      limitValuesSchema.safeParse({ "retention.trash_days": 60 }).success,
    ).toBe(false);
  });
});

describe("the limits an administrator sets", () => {
  it("are the rates, the rows of a file, jobs, sockets and an automation's pace, each set within its bounds, the shipped value among them", () => {
    expect(
      SETTABLE_LIMITS.filter((id) => !id.startsWith("rate.")).sort(),
    ).toEqual([
      "automation.max_delay_minutes",
      "automation.runs_per_minute",
      "export.file_hours",
      "export.max_rows",
      "import.max_rows",
      "jobs.active_per_account",
      "jobs.retention_days",
      "sockets.per_account",
    ]);
    expect(SETTABLE_LIMITS).toHaveLength(17);
    for (const id of SETTABLE_LIMITS) {
      const [floor, top] = LIMITS[id].bounds;
      expect(floor <= LIMITS[id].value && LIMITS[id].value <= top, id).toBe(
        true,
      );
    }
    expect(
      limitValuesSchema.parse({ "rate.auth": 5, "rate.app": 30_000 }),
    ).toEqual({ "rate.auth": 5, "rate.app": 30_000 });
    expect(limitIn("rate.auth", { "rate.auth": 40 })).toBe(40);
    expect(limitIn("rate.auth", {})).toBe(20);
    expect(limitValuesSchema.parse({ "import.max_rows": 2_500_000 })).toEqual({
      "import.max_rows": 2_500_000,
    });
    expect(limitIn("export.max_rows", {})).toBe(1_000_000);
    expect(
      limitValuesSchema.parse({
        "jobs.active_per_account": 50,
        "automation.max_delay_minutes": 10_080,
      }),
    ).toEqual({
      "jobs.active_per_account": 50,
      "automation.max_delay_minutes": 10_080,
    });
  });

  it("names the environment's variable that fixes the rows of a file", () => {
    expect(LIMITS["import.max_rows"].fixedBy).toBe("IMPORT_MAX_ROWS");
    expect(LIMITS["export.max_rows"].fixedBy).toBe("EXPORT_MAX_ROWS");
    expect(
      SETTABLE_LIMITS.filter((id) => id.startsWith("rate.")).every(
        (id) => !("fixedBy" in LIMITS[id]),
      ),
    ).toBe(true);
  });

  it("refuses a value past its bounds, a part of one, and a limit set elsewhere", () => {
    for (const values of [
      { "rate.auth": 4 },
      { "rate.auth": 121 },
      { "rate.api": 600.5 },
      { "read.rows_per_page": 500 },
      { "import.max_rows": 99_999 },
      { "jobs.active_per_account": 0 },
      { "sockets.per_account": 257 },
      { "sockets.channels_per_socket": 64 },
      { "export.max_rows": 10_000_001 },
    ]) {
      expect(
        limitValuesSchema.safeParse(values).success,
        JSON.stringify(values),
      ).toBe(false);
    }
    // A value stored past its bounds is not read: the limit keeps its own.
    expect(
      parseInstanceSettings({ limits: { "rate.auth": 1 } }).limits,
    ).toEqual({});
  });
});
