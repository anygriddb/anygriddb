/**
 * Every error the API reports to people (ADR 0013), with a stable code,
 * its HTTP status, and an English message for logs and REST clients. The
 * web app translates the code and its detail; it never reads the message.
 * Any other error is internal: people only learn that something failed.
 */

const BAD = 400;

export const ERRORS = {
  // Sign-in and accounts.
  invalid_credentials: [401, "Invalid credentials"],
  invalid_code: [401, "Invalid code"],
  webauthn_rejected: [401, "WebAuthn rejected"],
  challenge_expired: [401, "Challenge expired"],
  access_denied: [403, "Access denied"],
  mfa_enrollment_required: [403, "MFA enrollment required"],
  account_disabled: [403, "Account disabled"],
  account_locked: [403, "Account locked"],
  signup_closed: [403, "Signup closed"],
  signup_domain_not_allowed: [403, "Signup domain not allowed"],
  password_too_short: [BAD, "Password too short"],
  invalid_reset_link: [BAD, "Invalid reset link"],
  password_reset_disabled: [403, "Password reset disabled"],
  sso_account: [BAD, "Account signs in through single sign-on"],
  token_lifetime_too_long: [BAD, "Token lifetime too long"],
  api_tokens_restricted: [403, "API tokens restricted to administrators"],
  base_creation_restricted: [403, "Base creation restricted to administrators"],
  invitation_domain_not_allowed: [403, "Invitation domain not allowed"],
  instance_maintenance: [503, "Instance under maintenance"],
  unknown_account: [404, "Unknown account"],
  account_already_exists: [409, "Account already exists"],
  audit_history_retained: [409, "Audit history retained"],
  invalid_account: [BAD, "Invalid account"],
  invalid_invitation: [BAD, "Invalid invitation"],
  invalid_origin: [BAD, "Invalid origin"],
  invalid_totp_secret: [BAD, "Invalid totp secret"],

  // Catalog.
  unknown_base: [BAD, "Unknown base"],
  unknown_table: [BAD, "Unknown table"],
  unknown_view: [BAD, "Unknown view"],
  unknown_column: [BAD, "Unknown column"],
  unknown_dashboard: [BAD, "Unknown dashboard"],
  unknown_group: [BAD, "Unknown group"],
  unknown_widget: [BAD, "Unknown widget"],
  unknown_share: [BAD, "Unknown share"],
  public_links_disabled: [403, "Public links disabled"],
  share_password_required: [BAD, "Share password required"],
  unknown_template: [BAD, "Unknown template"],
  table_already_exists: [409, "Table already exists"],
  column_already_exists: [409, "Column already exists"],
  column_in_use: [BAD, "Column in use"],
  column_is_read_only: [BAD, "Column is read-only"],
  duplicate_column: [BAD, "Duplicate column"],
  duplicate_values: [BAD, "Duplicate values"],
  no_columns: [BAD, "No columns"],
  no_tables: [BAD, "No tables"],
  invalid_column: [BAD, "Invalid column"],
  invalid_column_name: [BAD, "Invalid column name"],
  invalid_table_name: [BAD, "Invalid table name"],
  invalid_identifier: [BAD, "Invalid identifier"],
  invalid_column_count: [BAD, "Invalid column count"],
  invalid_conversion: [BAD, "Invalid conversion"],
  invalid_default: [BAD, "Invalid default"],
  invalid_option: [BAD, "Invalid option"],
  invalid_order: [BAD, "Invalid order"],
  invalid_owner: [BAD, "Invalid owner"],
  invalid_relation: [BAD, "Invalid relation"],
  invalid_link_selection: [BAD, "Invalid link selection"],
  airtable_unauthorized: [BAD, "Airtable refused the token"],
  airtable_base_not_found: [BAD, "Airtable base not found"],
  airtable_failed: [BAD, "Airtable did not answer"],
  link_outside_selection: [BAD, "Linked row outside the field's selection"],
  invalid_restore: [BAD, "Invalid restore"],
  invalid_view: [BAD, "Invalid view"],
  invalid_unit: [BAD, "Invalid unit"],

  // Formulas.
  invalid_formula: [BAD, "Invalid formula"],
  formula_column_is_computed: [BAD, "Formula column is computed"],
  formula_too_large: [BAD, "Formula too large"],
  circular_formula: [BAD, "Circular formula"],
  unknown_field: [BAD, "Unknown field"],
  unknown_function: [BAD, "Unknown function"],
  invalid_arguments: [BAD, "Invalid arguments"],
  unexpected_character: [BAD, "Unexpected character"],
  unexpected_end_of_formula: [BAD, "Unexpected end of formula"],
  missing_closing_parenthesis: [BAD, "Missing closing parenthesis"],
  unterminated_field_reference: [BAD, "Unterminated field reference"],
  unterminated_string: [BAD, "Unterminated string"],

  // Rows.
  unknown_row: [BAD, "Unknown row"],
  no_row: [BAD, "No row"],
  row_locked: [409, "Row locked"],
  reason_required: [BAD, "Reason required"],
  invalid_reason: [BAD, "Invalid reason"],
  invalid_cell: [BAD, "Invalid cell"],
  invalid_value: [BAD, "Invalid value"],
  invalid_number: [BAD, "Invalid number"],
  invalid_link: [BAD, "Invalid link"],
  invalid_link_count: [BAD, "Invalid link count"],
  invalid_attachment: [BAD, "Invalid attachment"],
  invalid_comment: [BAD, "Invalid comment"],
  invalid_status: [BAD, "Invalid status"],
  invalid_row_id: [BAD, "Invalid row id"],
  invalid_record_id: [BAD, "Invalid record id"],

  // Reads.
  invalid_query: [BAD, "Invalid query"],
  invalid_filter: [BAD, "Invalid filter"],
  invalid_group: [BAD, "Invalid group"],
  invalid_aggregate: [BAD, "Invalid aggregate"],
  invalid_limit: [BAD, "Invalid limit"],
  invalid_offset: [BAD, "Invalid offset"],
  invalid_body: [BAD, "Invalid body"],

  // Imports, exports, snapshots, jobs, files.
  invalid_csv: [BAD, "Invalid csv"],
  invalid_import: [BAD, "Invalid import"],
  invalid_mapping: [BAD, "Invalid mapping"],
  unknown_import: [BAD, "Unknown import"],
  invalid_snapshot: [BAD, "Invalid snapshot"],
  unknown_snapshot: [BAD, "Unknown snapshot"],
  too_large_snapshot: [BAD, "Too large snapshot"],
  too_many_rows: [BAD, "Too many rows"],
  too_many_jobs: [BAD, "Too many jobs"],
  unknown_job: [BAD, "Unknown job"],
  invalid_job: [BAD, "Invalid job"],
  job_cancelled: [409, "Job cancelled"],
  interrupted: [409, "Interrupted"],
  invalid_file: [BAD, "Invalid file"],
  file_too_large: [413, "File too large"],
  storage_not_configured: [412, "Storage not configured"],
  smtp_not_configured: [412, "SMTP not configured"],

  // Integrations.
  invalid_webhook: [BAD, "Invalid webhook"],
  invalid_delivery: [BAD, "Invalid delivery"],
  invalid_automation: [BAD, "Invalid automation"],
  invalid_lock_ttl: [BAD, "Invalid lock ttl"],

  // Sources: client databases (ADRs 0006, 0026).
  unknown_source: [BAD, "Unknown source"],
  source_already_exists: [409, "Source already exists"],
  source_host_not_allowed: [403, "Source host not allowed"],
  source_engine_unsupported: [BAD, "Source engine not supported yet"],
  source_version_unsupported: [BAD, "Source version not supported"],
  source_engine_mismatch: [BAD, "Source engine differs from the server"],
  function_unavailable: [BAD, "The source engine cannot compute this"],
  source_time_zones_missing: [BAD, "Source has no time zone tables"],
  source_unreachable: [BAD, "Source unreachable"],
  source_timeout: [BAD, "Source timed out"],
  source_tls_unavailable: [BAD, "Source does not offer TLS"],
  source_tls_failed: [BAD, "Source certificate not trusted"],
  source_auth_failed: [BAD, "Source sign-in failed"],
  source_unknown_database: [BAD, "Source database not found"],
  source_admin_account: [BAD, "Source account is an administrator"],
  source_in_use: [409, "Source in use"],
  source_schema_changed: [BAD, "Source table changed"],
  source_query_failed: [BAD, "Source query failed"],
  source_query_too_complex: [BAD, "Source query too complex"],
  external_table_read_only: [BAD, "External table is read-only"],
  external_insert_off: [BAD, "Adding rows is off for this external table"],
  external_delete_off: [BAD, "Deleting rows is off for this external table"],
  external_table_no_key: [BAD, "External table has no primary key"],
  external_action_unavailable: [BAD, "Not available on an external table"],
  external_table_synced: [
    BAD,
    "External table is a synced copy: change it in its source",
  ],
  source_sync_too_large: [BAD, "Table too large to copy: read it live"],
  source_conflict: [409, "Row changed in the source since it was read"],
  row_changed_elsewhere: [
    409,
    "Row changed outside AnyGridDB since it was locked",
  ],
  source_row_missing: [409, "Row no longer in the source"],
  source_row_busy: [409, "Source row is locked by another write"],
  source_row_key_unknown: [BAD, "New row's key could not be read back"],
  source_value_required: [BAD, "Source column requires a value"],
  source_value_duplicate: [409, "Value already used in the source"],
  source_value_reference: [BAD, "Source foreign key refused the value"],
  source_value_check: [BAD, "Source check constraint refused the value"],
  source_value_too_long: [BAD, "Value too long for the source column"],
  source_value_invalid: [BAD, "Value does not fit the source column"],
  source_write_denied: [403, "Source account may not write here"],
  source_write_refused: [BAD, "Source refused the write"],
  external_table_schema: [BAD, "External table schema is the client's"],
  source_watch_column: [
    BAD,
    "Column cannot tell changes: choose a date and time, or a rowversion",
  ],
  source_watch_unavailable: [
    BAD,
    "Change Tracking is off for this table, or the account may not read it",
  ],
  source_side_none: [
    BAD,
    "This source has no side schema for the fields AnyGridDB adds",
  ],
  source_side_missing: [BAD, "The source's side schema does not exist"],
  source_side_denied: [
    403,
    "The source's account may not create tables in its side schema",
  ],
  control_plane_sort: [
    BAD,
    "This field is kept in AnyGridDB: it cannot sort or group a live client table",
  ],
  control_plane_filter: [
    BAD,
    "This field is kept in AnyGridDB: on a live client table it filters only a view, with AND, by equality or emptiness",
  ],
  control_plane_formula: [
    BAD,
    "This field is kept in AnyGridDB: formulas, lookups, and rollups cannot read it",
  ],
  control_plane_filter_broad: [
    BAD,
    "This filter on a field kept in AnyGridDB matches more than 1,000 rows: narrow it",
  ],
  source_side_in_use: [
    409,
    "Fields are kept in this side schema: it cannot change while they exist",
  ],
  source_changes_expired: [
    BAD,
    "Changes older than the source keeps were missed: the table was read again",
  ],

  // Transport: input that failed its schema before any rule ran, a request
  // without a session, a refusal with nothing more to say, a missing
  // resource, and a failure people are not told about.
  invalid_input: [BAD, "Invalid input"],
  unauthenticated: [401, "Authentication required"],
  request_rejected: [BAD, "Request rejected"],
  not_found: [404, "Not found"],
  internal_error: [500, "Internal error"],
} as const satisfies Record<string, readonly [number, string]>;

export type ErrorCode = keyof typeof ERRORS;

export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERRORS, value);
}

/**
 * An error people may read. `detail` names what it is about (a field, a
 * function, a character), and joins the English message after a colon.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  /** `new AppError(code)`, `(code, detail)`, `(code, { cause })`, or all three. */
  constructor(
    code: ErrorCode,
    detailOrOptions?: string | ErrorOptions,
    options?: ErrorOptions,
  ) {
    const [, message] = ERRORS[code];
    const detail =
      typeof detailOrOptions === "string" ? detailOrOptions : undefined;
    super(
      detail === undefined ? message : `${message}: ${detail}`,
      typeof detailOrOptions === "object" ? detailOrOptions : options,
    );
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return ERRORS[this.code][0];
  }
}

/** What a client receives about a failure: its code, detail, and message. */
export type PublicError = {
  code: ErrorCode;
  detail?: string;
  message: string;
};

export function publicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    return error.detail === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, detail: error.detail, message: error.message };
  }
  return { code: "internal_error", message: "Internal error" };
}
