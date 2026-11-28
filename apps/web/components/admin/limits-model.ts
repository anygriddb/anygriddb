import {
  LIMITS,
  type LimitEntry,
  type LimitId,
  type LimitValues,
  type SettableLimitId,
} from "@anygriddb/core";

/** The parts of the page "Limits and usage", in order. */
export type LimitFamily =
  | "rate"
  | "work"
  | "files"
  | "reads"
  | "content"
  | "access"
  | "outside"
  | "kept"
  | "automations";

export const LIMIT_FAMILIES: readonly LimitFamily[] = [
  "rate",
  "work",
  "files",
  "reads",
  "content",
  "access",
  "outside",
  "kept",
  "automations",
];

/** Each limit's part of the page: `satisfies Record<LimitId, …>` refuses a gap. */
export const FAMILY_OF = {
  "rate.auth": "rate",
  "rate.oauth": "rate",
  "rate.sign_on": "rate",
  "rate.share": "rate",
  "rate.api": "rate",
  "rate.upload": "rate",
  "rate.form_upload": "rate",
  "rate.report": "rate",
  "rate.app": "rate",
  "jobs.active_per_account": "work",
  "jobs.retention_days": "work",
  "export.file_hours": "work",
  "sockets.per_account": "work",
  "sockets.channels_per_socket": "work",
  "automation.runs_per_minute": "work",
  "automation.max_delay_minutes": "work",
  "import.max_rows": "files",
  "export.max_rows": "files",
  "copy.max_rows": "files",
  "import.text_bytes": "files",
  "import.xlsx_bytes": "files",
  "import.json_bytes": "files",
  "attachment.max_bytes": "files",
  "read.rows_per_page": "reads",
  "read.groups": "reads",
  "view.groups": "reads",
  "display.list_rows": "reads",
  "display.map_places": "reads",
  "display.calendar_rows": "reads",
  "retention.notifications_read_days": "kept",
  "retention.notifications_unread_days": "kept",
  "retention.automation_runs_days": "kept",
  "retention.deliveries_days": "kept",
  "retention.digest_days": "kept",
  "retention.source_load_days": "kept",
  "retention.trash_days": "kept",
  "retention.restore_point_days": "kept",
  "retention.sign_in_days": "kept",
  "automation.max_actions": "automations",
  "automation.max_nested_actions": "automations",
  "automation.max_loop_rows": "automations",
  "automation.max_script_chars": "automations",
  "automation.max_secrets": "automations",
  "sync.max_rows": "outside",
  "webhook.failures_before_off": "outside",
  "channel.failures_before_pause": "outside",
  "channel.deliveries_per_window": "outside",
  "channel.rate_window_ms": "outside",
  "channel.same_subject_ms": "outside",
  "channel.per_instance": "outside",
  "scim.page_rows": "outside",
  "scim.group_members": "outside",
  "accounts.bulk": "outside",
  "people.file_rows": "outside",
  "people.file_bytes": "outside",
  "people.file_bases": "outside",
  "widget.rows": "reads",
  "retention.closed_alerts_days": "kept",
  "retention.backup_runs_days": "kept",
  "export.account_list_rows": "files",
  "auth.second_factor_attempts": "access",
  "auth.email_code_attempts": "access",
  "auth.email_codes_per_hour": "access",
  "auth.pending_sign_ups": "access",
  "auth.waiting_guesses": "access",
  "link.password_attempts": "access",
  "link.lock_minutes": "access",
  "protocol.second_factor_ms": "access",
  "protocol.email_code_ms": "access",
  "protocol.email_code_gap_ms": "access",
  "protocol.sign_on_state_ms": "access",
  "protocol.provider_discovery_ms": "access",
  "protocol.erase_sign_in_ms": "access",
  "protocol.install_token_ms": "access",
  "protocol.reset_link_ms": "access",
  "protocol.admin_reset_link_ms": "access",
  "protocol.account_link_ms": "access",
  "protocol.saml_request_ms": "access",
  "protocol.sign_up_link_ms": "access",
  "protocol.proof_ms": "access",
  "protocol.token_days": "access",
  "protocol.totp_step_ms": "access",
  "protocol.passkey_ms": "access",
  "protocol.logout_token_chars": "access",
  "protocol.logout_token_seconds": "access",
  "protocol.sign_on_again_seconds": "access",
  "protocol.acting_as_ms": "access",
  "protocol.base_opening_minutes": "access",
  "protocol.invitation_ms": "access",
  "protocol.link_unlocked_ms": "access",
  "protocol.oauth_code_ms": "access",
  "protocol.oauth_refresh_days": "access",
  "protocol.admin_lock_minutes": "access",
  "alerts.reminder_hours": "work",
  "retention.staged_file_hours": "kept",
  "trail.table_open_hours": "kept",
  "automation.script_log_lines": "automations",
  "automation.script_log_chars": "automations",
  "automation.script_error_chars": "automations",
  "automation.email_recipients": "automations",
  "automation.event_depth": "automations",
  "comments.listed": "reads",
  "chart.series": "reads",
  "chart.categories": "reads",
  "formula.lookup_hops": "content",
  "export.csv_chars": "files",
  "import.errors_listed": "files",
  "import.options_added": "files",
  "conversion.options_added": "content",
  "notice.recipients": "outside",
  "notice.subject_chars": "outside",
  "notice.body_chars": "outside",
  "notice.per_hour": "outside",
  "logs.lines_kept": "kept",
  "logs.bytes_kept": "kept",
  "api.records_per_call": "reads",
  "sockets.message_chars": "work",
  "sockets.buffered_bytes": "work",
  "sockets.queued_messages": "work",
  "sockets.early_messages": "work",
  "copy.answer_bytes": "outside",
  "copy.collections_listed": "outside",
  "copy.fields_read": "outside",
  "copy.indices_listed": "outside",
  "source.tables_listed": "outside",
  "request.input_depth": "reads",
  "grid.series_rows": "content",
  "cell.place_chars": "content",
  "field.mask_chars": "content",
  "cell.list_items": "content",
  "cell.files": "content",
  "link.embed_origins": "access",
  "filter.depth": "content",
  "filter.conditions": "content",
  "formula.nodes": "content",
  "formula.depth": "content",
  "formula.source_chars": "content",
  "formula.repeat_chars": "content",
  "formula.sql_chars": "content",
  "formula.json_path_steps": "content",
  "read.offset": "reads",
  "formula.computed_chars": "content",
  "chart.histogram_bins": "reads",
  "logo.bytes": "files",
  "cell.json_chars": "content",
  "cell.json_depth": "content",
  "comments.mentions": "content",
  "snapshot.link_pairs": "files",
  "write.rows_per_call": "content",
  "restore.points_per_base": "kept",
  "write.links_per_cell": "content",
  "display.table_activity": "reads",
  "snapshot.rows": "files",
  "snapshot.line_bytes": "files",
  "snapshot.tables": "files",
  "snapshot.folders": "files",
  "snapshot.bytes": "files",
  "snapshot.archive_bytes": "files",
  "snapshot.files": "files",
  "snapshot.comments": "files",
  "snapshot.dashboards": "files",
  "snapshot.widgets": "files",
  "view.sorts": "content",
  "view.frozen_fields": "content",
  "attachment.max_bytes_top": "files",
  "timeout.mcp_call_ms": "outside",
  "timeout.object_store_ms": "outside",
  "timeout.object_store_connect_ms": "outside",
  "timeout.outbound_ms": "outside",
  "timeout.provider_ms": "outside",
  "timeout.syslog_ms": "outside",
  "timeout.release_check_ms": "outside",
  "timeout.import_call_ms": "outside",
  "timeout.client_status_fence_ms": "outside",
  "timeout.first_bytes_ms": "outside",
  "retention.staged_import_seconds": "kept",
  "retention.queued_import_seconds": "kept",
  "retention.staged_workbook_seconds": "kept",
  "retention.queued_workbook_seconds": "kept",
  "retention.parse_folder_ms": "kept",
  "automation.script_answer_bytes": "automations",
  "import.call_answer_bytes": "outside",
  "release.answer_bytes": "outside",
  "feed.past_days": "reads",
  "feed.future_days": "reads",
  "retention.staged_snapshot_seconds": "kept",
  "retention.queued_snapshot_seconds": "kept",
  "usage.active_days": "reads",
  "usage.trend_days": "reads",
  "auth.acting_reason_chars": "access",
  "import.field_name_chars": "files",
  "request.link_calls": "reads",
  "copy.id_chars": "outside",
  "automation.script_time_ms": "automations",
  "automation.script_run_ms": "automations",
  "automation.script_memory_bytes": "automations",
  "automation.script_calls": "automations",
  "automation.script_call_bytes": "automations",
  "automation.script_reply_bytes": "automations",
  "automation.script_output_bytes": "automations",
  "automation.script_heap_mb": "automations",
  "automation.script_start_ms": "automations",
  "automation.script_grace_ms": "automations",
  "import.parse_heap_mb": "files",
  "import.scan_ms": "files",
  "import.batch_ms": "files",
  "import.zip_entries": "files",
  "import.zip_entry_bytes": "files",
  "import.zip_total_bytes": "files",
  "storage.base_mib": "files",
  "storage.account_mib": "files",
} as const satisfies Record<LimitId, LimitFamily>;

/** What the page holds of the limits an administrator sets: each as typed. */
export type LimitDraft = Partial<Record<SettableLimitId, string>>;

/**
 * What is typed in one part of the page, and what is typed elsewhere:
 * each part saves its own fields, and leaves the others as typed.
 */
export function splitDraft(
  draft: LimitDraft,
  family: LimitFamily,
): [LimitDraft, LimitDraft] {
  const inside: LimitDraft = {};
  const outside: LimitDraft = {};
  for (const [id, typed] of Object.entries(draft) as Array<
    [SettableLimitId, string]
  >) {
    if (FAMILY_OF[id] === family) inside[id] = typed;
    else outside[id] = typed;
  }
  return [inside, outside];
}

/**
 * The limits to save from what is typed: a value equal to the shipped one
 * is left out (the limit then follows a later version's), an empty field
 * goes back to it. A value that is no whole number within its bounds is
 * named, and nothing is saved.
 */
export function limitsFromDraft(
  draft: LimitDraft,
  set: LimitValues,
): { limits: LimitValues } | { invalid: SettableLimitId[] } {
  const limits: Record<string, number> = {};
  const invalid: SettableLimitId[] = [];
  for (const id of Object.keys(LIMITS) as LimitId[]) {
    const entry: LimitEntry = LIMITS[id];
    if (entry.setBy !== "limits" || !entry.bounds) continue;
    const settable = id as SettableLimitId;
    const typed = draft[settable];
    const text = typed === undefined ? undefined : typed.trim();
    if (text === "") continue;
    const value =
      text === undefined
        ? set[settable]
        : /^\d+$/.test(text)
          ? Number(text)
          : NaN;
    if (value === undefined) continue;
    const [floor, top] = entry.bounds;
    if (!Number.isSafeInteger(value) || value < floor || value > top) {
      invalid.push(settable);
      continue;
    }
    if (value !== entry.value) limits[settable] = value;
  }
  return invalid.length > 0 ? { invalid } : { limits };
}
