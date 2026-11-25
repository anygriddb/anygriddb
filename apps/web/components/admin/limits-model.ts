import {
  LIMITS,
  type LimitEntry,
  type LimitId,
  type LimitValues,
  type SettableLimitId,
} from "@anygriddb/core";

/** The parts of the page "Limits and usage", in order. */
export type LimitFamily =
  "rate" | "work" | "files" | "reads" | "kept" | "automations";

export const LIMIT_FAMILIES: readonly LimitFamily[] = [
  "rate",
  "work",
  "files",
  "reads",
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
} as const satisfies Record<LimitId, LimitFamily>;

/** What the page holds of the limits an administrator sets: each as typed. */
export type LimitDraft = Partial<Record<SettableLimitId, string>>;

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
