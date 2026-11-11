/**
 * What a failure says to people (ADR 0013). The API sends a stable code
 * and, sometimes, a detail such as a field name; this file holds the
 * message of every code. The English text of a failure is never read.
 */
import { ERRORS, isErrorCode, type ErrorCode } from "@anygriddb/core";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { useCallback } from "react";
import { knownText } from "./known-text";

export const ERROR_MESSAGES: Record<ErrorCode, MessageDescriptor> = {
  invalid_credentials: msg`Invalid email or password`,
  invalid_code: msg`Invalid code`,
  webauthn_rejected: msg`The passkey was not accepted`,
  challenge_expired: msg`Time is up: start again`,
  access_denied: msg`Access denied`,
  mfa_enrollment_required: msg`Turn on a second factor in your settings`,
  account_disabled: msg`This account is disabled`,
  account_locked: msg`This account is locked after too many failed attempts. Try again later, or ask an administrator to unlock it.`,
  signup_closed: msg`Sign-up is not open for this address`,
  signup_domain_not_allowed: msg`Sign-up is open only to your organization's addresses`,
  password_too_short: msg`Password too short. Minimum length`,
  invalid_reset_link: msg`This link no longer works: ask for a new one`,
  password_reset_disabled: msg`Ask an administrator to reset your password`,
  sso_account: msg`This account signs in through your organization's sign-in: it has no password here`,
  token_lifetime_too_long: msg`Too long for this instance. Most days allowed`,
  api_tokens_restricted: msg`On this instance, only administrators create API tokens`,
  base_creation_restricted: msg`On this instance, only administrators create bases`,
  invitation_domain_not_allowed: msg`On this instance, people are invited only with your organization's addresses`,
  instance_maintenance: msg`The instance is under maintenance. Try again later.`,
  unknown_account: msg`No account with this email`,
  account_already_exists: msg`This account already exists`,
  audit_history_retained: msg`This account has an audit history: an administrator can disable it`,
  invalid_account: msg`This cannot be done to this account`,
  invalid_invitation: msg`This invitation does not exist or has expired`,
  invalid_origin: msg`Passkeys need a hostname in PUBLIC_URL (a DNS name or localhost), not an IP address. Open AnyGridDB at that address, or use a TOTP app.`,
  invalid_totp_secret: msg`Invalid TOTP secret`,

  unknown_base: msg`Base not found`,
  unknown_table: msg`Table not found`,
  unknown_view: msg`View not found`,
  unknown_column: msg`Unknown field`,
  unknown_dashboard: msg`Dashboard not found`,
  unknown_group: msg`Group not found`,
  unknown_widget: msg`Widget not found`,
  public_links_disabled: msg`Public links are turned off on this instance`,
  share_password_required: msg`On this instance, a public link needs a password`,
  unknown_share: msg`Share not found`,
  unknown_template: msg`Unknown template`,
  table_already_exists: msg`A table already has this name`,
  column_already_exists: msg`A field already has this name`,
  column_in_use: msg`Field used by`,
  column_is_read_only: msg`This field is read-only`,
  duplicate_column: msg`This field appears twice`,
  duplicate_values: msg`Duplicate values prevent uniqueness`,
  no_columns: msg`No fields`,
  no_tables: msg`Add at least one table before exporting`,
  invalid_column: msg`Invalid field`,
  invalid_column_name: msg`Invalid field name`,
  invalid_table_name: msg`Invalid table name`,
  invalid_identifier: msg`Invalid identifier`,
  invalid_column_count: msg`Invalid number of fields`,
  invalid_conversion: msg`This conversion is not possible`,
  invalid_default: msg`Invalid default value`,
  invalid_option: msg`Invalid option`,
  invalid_order: msg`Invalid order`,
  invalid_owner: msg`A base must keep at least one owner`,
  invalid_relation: msg`Invalid link`,
  invalid_link_selection: msg`Pick a shared view of the linked table`,
  airtable_unauthorized: msg`Airtable refuses this token: it needs data.records:read and schema.bases:read on this base`,
  airtable_base_not_found: msg`Airtable cannot find this base, or the token has no access to it`,
  airtable_failed: msg`Airtable did not answer: try again later`,
  link_outside_selection: msg`This row is not among those this field offers: pick one from the list`,
  invalid_restore: msg`Cannot restore: restore the table or fields it depends on first`,
  invalid_view: msg`Invalid view`,
  invalid_unit: msg`Invalid unit`,

  invalid_formula: msg`Invalid formula`,
  formula_column_is_computed: msg`This field is computed`,
  formula_too_large: msg`Formula too long`,
  circular_formula: msg`Circular formula: it depends on itself`,
  unknown_field: msg`Unknown column`,
  unknown_function: msg`Unknown function`,
  invalid_arguments: msg`Invalid arguments for`,
  unexpected_character: msg`Unexpected character`,
  unexpected_end_of_formula: msg`Incomplete formula`,
  missing_closing_parenthesis: msg`Missing closing parenthesis`,
  unterminated_field_reference: msg`Unclosed field reference`,
  unterminated_string: msg`Unclosed text: a quote is missing`,

  unknown_row: msg`No row`,
  no_row: msg`Row not found`,
  row_locked: msg`Row locked`,
  reason_required: msg`A reason is required`,
  invalid_reason: msg`Invalid reason`,
  invalid_cell: msg`Invalid value`,
  invalid_value: msg`Invalid value for`,
  invalid_number: msg`Invalid number`,
  invalid_link: msg`Invalid link`,
  invalid_link_count: msg`This link takes only one row`,
  invalid_attachment: msg`Invalid attachment`,
  invalid_comment: msg`Invalid comment`,
  invalid_status: msg`Status change refused`,
  invalid_row_id: msg`Invalid row identifier`,
  invalid_record_id: msg`Invalid record identifier`,

  invalid_query: msg`Invalid query`,
  invalid_filter: msg`Invalid filter`,
  invalid_group: msg`Invalid grouping`,
  invalid_aggregate: msg`Invalid aggregate`,
  invalid_limit: msg`Invalid limit`,
  invalid_offset: msg`Invalid position`,
  invalid_body: msg`Invalid request body`,

  invalid_csv: msg`Invalid CSV file: check the headers and values`,
  invalid_import: msg`Unreadable file: use a CSV, TSV, JSON, or Excel file with a header row`,
  invalid_mapping: msg`Invalid column mapping`,
  unknown_import: msg`Import expired: drop the file again`,
  invalid_snapshot: msg`Unreadable base file`,
  unknown_snapshot: msg`Unknown import`,
  too_large_snapshot: msg`File too large (2 GiB at most)`,
  too_many_rows: msg`Too many rows (100,000 at most)`,
  too_many_jobs: msg`Too many jobs running: wait for one to finish`,
  unknown_job: msg`Job not found`,
  invalid_job: msg`Invalid job`,
  job_cancelled: msg`Job cancelled`,
  interrupted: msg`The job was interrupted by a restart. Start it again.`,
  invalid_file: msg`Invalid file`,
  file_too_large: msg`File too large`,
  storage_not_configured: msg`File storage is not set up`,
  smtp_not_configured: msg`Email is not set up on this instance`,

  invalid_webhook: msg`Invalid webhook: a public HTTPS address or an email is required`,
  invalid_delivery: msg`This delivery cannot be sent again`,
  invalid_automation: msg`Invalid automation`,
  invalid_lock_ttl: msg`Invalid lock duration`,

  unknown_source: msg`Source not found`,
  source_already_exists: msg`A source already has this name`,
  source_host_not_allowed: msg`This host is not allowed: the operator adds it to ANYGRIDDB_SOURCES_ALLOWED_HOSTS`,
  source_engine_unsupported: msg`This engine is not supported yet`,
  source_version_unsupported: msg`This server version is not supported: PostgreSQL 13, MySQL 8.0, MariaDB 10.6, SQL Server 2017 or later`,
  source_engine_mismatch: msg`The server is not of the chosen engine: MySQL and MariaDB differ`,
  function_unavailable: msg`This database engine cannot compute it`,
  source_time_zones_missing: msg`The server has no time zone tables: ask its administrator to load them (mysql_tzinfo_to_sql)`,
  source_unreachable: msg`Source unreachable: check the host, the port, and the firewall`,
  source_timeout: msg`The source did not answer in time`,
  source_tls_unavailable: msg`The source does not offer TLS: enable it on the server`,
  source_tls_failed: msg`The source's certificate is not trusted: paste its certificate authority or its certificate`,
  source_auth_failed: msg`Sign-in refused: check the account and the password`,
  source_unknown_database: msg`Database not found on the source`,
  source_admin_account: msg`This account is an administrator: create an account dedicated to AnyGridDB`,

  source_in_use: msg`Tables of this source are in a base, or in its trash: delete them first`,
  source_schema_changed: msg`The client's table changed: refresh its fields`,
  source_query_failed: msg`The client's database refused the query`,
  source_query_too_complex: msg`SQL Server finds this read too complex: the table has too many computed fields for one query. This is a SQL Server limit.`,
  external_table_read_only: msg`Changes are not allowed on this table: an administrator can enable them in its source`,
  external_insert_off: msg`Adding rows is not allowed on this table: an administrator can enable it in its source`,
  external_delete_off: msg`Deleting rows is not allowed on this table: an administrator can enable it in its source`,
  external_table_no_key: msg`This table has no primary key: its rows cannot be changed`,
  external_action_unavailable: msg`This action is not available on a client's table yet`,
  external_table_synced: msg`This table is a copy refreshed on a schedule: change it in the client's database`,
  source_sync_too_large: msg`This table has over a million rows: read it live rather than from a copy`,
  source_conflict: msg`This value changed in the client's database since you read it: the current value now shows, make your change again if needed`,
  row_changed_elsewhere: msg`This row was changed outside AnyGridDB since it was locked: unlock it, check it, then lock it again`,
  source_row_missing: msg`This row no longer exists in the client's database`,
  source_row_busy: msg`Another application is changing this row: try again in a moment`,
  source_row_key_unknown: msg`The client's database does not give the new row's key: fill it in`,
  source_value_required: msg`The client's database requires a value`,
  source_value_duplicate: msg`This value already exists in the client's database`,
  source_value_reference: msg`The client's database cannot find the linked row`,
  source_value_check: msg`A rule of the client's database refuses this value`,
  source_value_too_long: msg`Text too long for the client's database column`,
  source_value_invalid: msg`This value does not fit the client's database column`,
  source_write_denied: msg`The source's account may not make this change: its administrator can grant it`,
  source_write_refused: msg`The client's database refused the change`,
  external_table_schema: msg`AnyGridDB does not change a client's table: this field cannot be added or changed there`,
  source_watch_column: msg`This column does not tell when a row changes: choose a date and time set on every change, or a rowversion`,
  source_watch_unavailable: msg`Change Tracking is off on this table, or the account lacks VIEW CHANGE TRACKING`,
  control_plane_sort: msg`This field is kept in AnyGridDB: it cannot sort or group a live client table`,
  control_plane_filter: msg`This field is kept in AnyGridDB: on a live client table it filters only a view, with AND, by equality or emptiness`,
  control_plane_formula: msg`This field is kept in AnyGridDB: formulas, lookups, and rollups cannot read it`,
  control_plane_filter_broad: msg`This filter on a field kept in AnyGridDB matches more than 1,000 rows: narrow it`,
  source_side_in_use: msg`Fields are kept in this side schema: it cannot change while they exist`,
  source_side_none: msg`To add this field, an administrator names in the source a schema of the client's database kept for AnyGridDB: the client's tables are never changed`,
  source_side_missing: msg`The schema kept for AnyGridDB does not exist in the client's database: its administrator must create it`,
  source_side_denied: msg`The source's account may not create tables in the schema kept for AnyGridDB: its administrator must allow it`,
  source_changes_expired: msg`SQL Server no longer kept the changes: the table was read again in full`,

  release_check_disabled: msg`Turn on the release check in Health first`,
  release_check_failed: msg`Could not reach the release feed`,

  invalid_input: msg`Invalid input`,
  unauthenticated: msg`Sign in to continue`,
  request_rejected: msg`Request refused`,
  not_found: msg`Not found`,
  internal_error: msg`Internal error`,
};

/** A message and what it is about, such as a field: `Champ inconnu : prix`. */
const WITH_DETAIL = msg`${{ message: "" }}: ${{ detail: "" }}`;

export type Reason = { code: ErrorCode; detail?: string };

function asReason(value: unknown): Reason | undefined {
  if (!value || typeof value !== "object" || !("code" in value)) return;
  if (!isErrorCode(value.code)) return;
  const detail =
    "detail" in value && typeof value.detail === "string"
      ? value.detail
      : undefined;
  return { code: value.code, detail };
}

/**
 * The code of a failure, wherever it comes from: a tRPC call
 * (`data.reason`), an HTTP route's body (`code`), or a job (`reason`).
 */
export function reasonOf(cause: unknown): Reason {
  if (cause && typeof cause === "object") {
    if ("data" in cause && cause.data && typeof cause.data === "object") {
      const fromTrpc = asReason(
        "reason" in cause.data ? cause.data.reason : undefined,
      );
      if (fromTrpc) return fromTrpc;
    }
    if ("reason" in cause) {
      const fromJob = asReason(cause.reason);
      if (fromJob) return fromJob;
    }
    const fromBody = asReason(cause);
    if (fromBody) return fromBody;
  }
  return { code: "request_rejected" };
}

const BY_MESSAGE = new Map<string, ErrorCode>(
  (Object.keys(ERRORS) as ErrorCode[]).map((code) => [ERRORS[code][1], code]),
);

/**
 * The code of a failure stored as text by a record made without codes:
 * an automation step or a webhook delivery (`Unknown column: prix`).
 */
function storedReason(text: string): Reason | undefined {
  const exact = BY_MESSAGE.get(text);
  if (exact) return { code: exact };
  const colon = text.indexOf(": ");
  const code = colon > 0 ? BY_MESSAGE.get(text.slice(0, colon)) : undefined;
  return code ? { code, detail: text.slice(colon + 2) } : undefined;
}

/**
 * Turns a failure into a sentence in the person's language: a thrown
 * error, a response body, a job, or the text an older record stored.
 */
export function useErrorText(): (cause: unknown) => string {
  const { i18n } = useLingui();
  return useCallback(
    (cause: unknown) => {
      if (typeof cause === "string") {
        const value = knownText(cause);
        if (value) return i18n._(value);
        const stored = storedReason(cause);
        if (!stored) return cause;
        cause = stored;
      }
      const reason = reasonOf(cause);
      const message = i18n._(ERROR_MESSAGES[reason.code]);
      return reason.detail === undefined
        ? message
        : i18n._({
            ...WITH_DETAIL,
            values: { message, detail: reason.detail },
          });
    },
    [i18n],
  );
}
