import type {
  LimitId,
  LimitScope,
  LimitSetBy,
  LimitUnit,
  LimitValues,
  SettableLimitId,
} from "@anygriddb/core";
import { Button, Input, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { intlLocale } from "../../lib/format";
import { useFormatBytes } from "../../lib/format-bytes";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import { AdminTable, AdminTableHead } from "./admin-list";
import {
  FAMILY_OF,
  LIMIT_FAMILIES,
  limitsFromDraft,
  splitDraft,
  type LimitDraft,
  type LimitFamily,
} from "./limits-model";
import { useStepUp } from "./step-up";

type LimitRow = RouterOutputs["admin"]["limits"][number];

/**
 * Saves the limits once the proof is given: null when saved, "declined"
 * when the proof was not, else what refused them.
 */
async function sendLimits(
  limits: LimitValues,
  ensureProof: () => Promise<boolean>,
): Promise<null | "declined" | { cause: unknown }> {
  try {
    if (!(await ensureProof())) return "declined";
    await trpc.admin.updateSettings.mutate({ limits });
    return null;
  } catch (cause) {
    return { cause };
  }
}

function useLimitNames(): Record<LimitId, string> {
  const { t } = useLingui();
  return {
    "rate.auth": t`Sign-ins and codes`,
    "rate.oauth": t`An application's tokens`,
    "rate.sign_on": t`Single sign-on`,
    "rate.share": t`Public links, forms and feeds`,
    "rate.api": t`REST API, MCP and SCIM`,
    "rate.upload": t`Files sent`,
    "rate.form_upload": t`Files sent to public forms`,
    "rate.report": t`Failures pages report`,
    "rate.app": t`Everything else in the app`,
    "jobs.active_per_account": t`Jobs queued or running`,
    "jobs.retention_days": t`A finished job kept`,
    "export.file_hours": t`An export's file kept`,
    "sockets.per_account": t`Live connections`,
    "sockets.channels_per_socket": t`Pages one connection follows`,
    "automation.runs_per_minute": t`An automation's runs`,
    "automation.max_delay_minutes": t`An automation's wait`,
    "import.max_rows": t`Rows imported at once`,
    "export.max_rows": t`Rows exported at once`,
    "copy.max_rows": t`Rows copied at once`,
    "import.text_bytes": t`A CSV or text file imported`,
    "import.xlsx_bytes": t`A spreadsheet imported`,
    "import.json_bytes": t`A JSON file imported`,
    "attachment.max_bytes": t`A file in a cell`,
    "read.rows_per_page": t`Rows a page reads`,
    "read.groups": t`Groups a page reads`,
    "view.groups": t`Levels of grouping`,
    "display.list_rows": t`Rows a list shows`,
    "display.map_places": t`Places a map shows`,
    "display.calendar_rows": t`Rows a calendar shows`,
    "retention.notifications_read_days": t`A notification read`,
    "retention.notifications_unread_days": t`A notification not read`,
    "retention.automation_runs_days": t`An automation's run`,
    "retention.deliveries_days": t`A delivery of a webhook or a channel`,
    "retention.digest_days": t`A notice waiting for a digest`,
    "retention.source_load_days": t`A source's load, measured`,
    "retention.trash_days": t`What is deleted, in the trash`,
    "retention.restore_point_days": t`A restore point`,
    "retention.sign_in_days": t`The sign-in trail`,
    "automation.max_actions": t`Actions in an automation`,
    "automation.max_nested_actions": t`Actions inside a condition or a loop`,
    "automation.max_loop_rows": t`Rows a loop goes through`,
    "automation.max_script_chars": t`Characters of a script`,
    "automation.max_secrets": t`Secrets of an automation`,
    "sync.max_rows": t`Rows of a synced copy`,
    "webhook.failures_before_off": t`Failed deliveries before a webhook stops`,
    "channel.failures_before_pause": t`Failed deliveries before a channel pauses`,
    "channel.deliveries_per_window": t`Notices a channel sends in its window`,
    "channel.rate_window_ms": t`A channel's window`,
    "channel.same_subject_ms": t`The same notice not sent again`,
    "channel.per_instance": t`Notification channels`,
    "scim.page_rows": t`Accounts a directory reads at once`,
    "scim.group_members": t`Members of a directory's group`,
    "accounts.bulk": t`Accounts changed at once`,
    "people.file_rows": t`People in a file of people`,
    "people.file_bytes": t`A file of people`,
    "people.file_bases": t`Bases a file of people names`,
    "widget.rows": t`Rows a widget shows`,
    "retention.closed_alerts_days": t`An alert that has ended`,
    "retention.backup_runs_days": t`A backup's report`,
    "export.account_list_rows": t`Lines of each list in an account's data`,
    "auth.second_factor_attempts": t`Tries at a second factor`,
    "auth.email_code_attempts": t`Tries at a code by email`,
    "auth.email_codes_per_hour": t`Codes by email an hour`,
    "auth.pending_sign_ups": t`Sign-ups waiting at one address`,
    "auth.waiting_guesses": t`Sign-ins waiting their turn`,
    "link.password_attempts": t`Tries at a link's password`,
    "link.lock_minutes": t`A link locked after too many tries`,
    "protocol.second_factor_ms": t`A second factor's challenge`,
    "protocol.email_code_ms": t`A code by email`,
    "protocol.email_code_gap_ms": t`Between two codes by email`,
    "protocol.sign_on_state_ms": t`A single sign-on under way`,
    "protocol.provider_discovery_ms": t`An identity provider's settings, read again`,
    "protocol.erase_sign_in_ms": t`A sign-in recent enough to erase an account`,
    "protocol.install_token_ms": t`The installation token`,
    "protocol.reset_link_ms": t`A reset link asked for`,
    "protocol.admin_reset_link_ms": t`A reset link an administrator sends`,
    "protocol.account_link_ms": t`The first link of a new account`,
    "protocol.saml_request_ms": t`A SAML request under way`,
    "protocol.sign_up_link_ms": t`A sign-up's link`,
    "protocol.proof_ms": t`The proof Administration asks for`,
    "protocol.token_days": t`An API token, unless its maker says`,
    "protocol.totp_step_ms": t`An authenticator's code`,
    "protocol.passkey_ms": t`A passkey's ceremony`,
    "protocol.logout_token_chars": t`A provider's logout token`,
    "protocol.logout_token_seconds": t`A provider's logout token, its age`,
    "protocol.sign_on_again_seconds": t`Single sign-on asked again`,
    "protocol.acting_as_ms": t`An administrator acting as someone`,
    "protocol.base_opening_minutes": t`A base an administrator opens`,
    "protocol.invitation_ms": t`An invitation`,
    "protocol.link_unlocked_ms": t`A link's password, given`,
    "protocol.oauth_code_ms": t`An application's code`,
    "protocol.oauth_refresh_days": t`An application's renewal`,
    "protocol.admin_lock_minutes": t`An administrator locked out`,
    "alerts.reminder_hours": t`An alert sent again`,
    "retention.staged_file_hours": t`A file sent and not yet used`,
    "trail.table_open_hours": t`A table's opening, written once`,
    "automation.script_log_lines": t`Lines a script logs`,
    "automation.script_log_chars": t`A line a script logs`,
    "automation.script_error_chars": t`A script's error`,
    "automation.email_recipients": t`Recipients of an automation's mail`,
    "automation.event_depth": t`Automations one change sets off in turn`,
    "comments.listed": t`Comments a row shows`,
    "chart.series": t`Series of a chart`,
    "chart.categories": t`Categories of a chart`,
    "formula.lookup_hops": t`Links a lookup follows`,
    "export.csv_chars": t`A CSV file downloaded`,
    "import.errors_listed": t`Errors an import lists`,
    "import.options_added": t`Options an import adds to a field`,
    "conversion.options_added": t`Options a conversion adds to a field`,
    "notice.recipients": t`Recipients of a notice to accounts`,
    "notice.subject_chars": t`A notice's subject`,
    "notice.body_chars": t`A notice's text`,
    "notice.per_hour": t`Notices to accounts an hour`,
    "logs.lines_kept": t`Lines of the log Administration shows`,
    "logs.bytes_kept": t`The log Administration shows`,
    "api.records_per_call": t`Records one call of the API writes`,
    "sockets.message_chars": t`A message a page sends live`,
    "sockets.buffered_bytes": t`What waits for a slow connection`,
    "sockets.queued_messages": t`Messages waiting for a connection`,
    "sockets.early_messages": t`Messages before a connection is ready`,
    "copy.answer_bytes": t`An answer of a store read through its API`,
    "copy.collections_listed": t`Collections or indices listed`,
    "copy.fields_read": t`Fields read of a collection or an index`,
    "copy.indices_listed": t`Indices listed`,
    "source.tables_listed": t`Tables listed of a client's database`,
    "request.input_depth": t`Levels of what a call sends`,
    "grid.series_rows": t`Rows a series typed in figures reaches`,
    "cell.place_chars": t`A place's name`,
    "cell.list_items": t`Items of a list in a cell`,
    "cell.files": t`Files in a cell`,
    "link.embed_origins": t`Sites a link may be shown in`,
    "filter.depth": t`Levels of a filter`,
    "filter.conditions": t`Conditions of a filter`,
    "formula.nodes": t`Parts of a formula`,
    "formula.depth": t`Levels of a formula`,
    "formula.source_chars": t`A formula's text`,
    "formula.repeat_chars": t`Text a formula repeats`,
    "formula.sql_chars": t`A formula, once written as a query`,
    "formula.json_path_steps": t`Steps of a path into JSON`,
    "read.offset": t`Rows a page may skip`,
    "formula.computed_chars": t`Text a formula computes`,
    "chart.histogram_bins": t`Bars of a histogram`,
    "logo.bytes": t`The instance's logo`,
    "cell.json_chars": t`JSON in a cell`,
    "cell.json_depth": t`Levels of JSON in a cell`,
    "comments.mentions": t`People one comment mentions`,
    "snapshot.link_pairs": t`Links a snapshot carries per field`,
    "write.rows_per_call": t`Rows one change writes`,
    "restore.points_per_base": t`Restore points of a base`,
    "write.links_per_cell": t`Links written to one cell`,
    "display.table_activity": t`Tables a base's activity names`,
    "snapshot.rows": t`Rows of a table in a snapshot`,
    "snapshot.line_bytes": t`A line of a snapshot`,
    "snapshot.tables": t`Tables of a snapshot`,
    "snapshot.folders": t`Folders of a snapshot`,
    "snapshot.bytes": t`A snapshot, without its files`,
    "snapshot.archive_bytes": t`A snapshot's archive`,
    "snapshot.files": t`Files of a snapshot`,
    "snapshot.comments": t`Comments of a snapshot`,
    "snapshot.dashboards": t`Dashboards of a snapshot`,
    "snapshot.widgets": t`Widgets of a snapshot`,
    "view.sorts": t`Sorts of a view`,
    "view.frozen_fields": t`Fields a view keeps in place`,
    "attachment.max_bytes_top": t`The most a file in a cell may be set to`,
    "timeout.mcp_call_ms": t`A call of MCP`,
    "timeout.object_store_ms": t`A call to the object store`,
    "timeout.object_store_connect_ms": t`Reaching the object store`,
    "timeout.outbound_ms": t`A call out of the instance`,
    "timeout.provider_ms": t`Reading an identity provider`,
    "timeout.syslog_ms": t`A line to the syslog collector`,
    "timeout.release_check_ms": t`Asking for a newer version`,
    "timeout.import_call_ms": t`A call of an import from another product`,
    "timeout.client_status_fence_ms": t`A client's row held while its status changes`,
    "timeout.first_bytes_ms": t`A connection's first bytes`,
    "retention.staged_import_seconds": t`A file sent to import, not yet imported`,
    "retention.queued_import_seconds": t`An import waiting for its job`,
    "retention.staged_workbook_seconds": t`A workbook sent, not yet imported`,
    "retention.queued_workbook_seconds": t`A workbook waiting for its job`,
    "retention.parse_folder_ms": t`An import's working folder`,
    "automation.script_answer_bytes": t`An answer a script's call reads`,
    "import.call_answer_bytes": t`An answer of an import from another product`,
    "release.answer_bytes": t`The answer to a check for a newer version`,
    "feed.past_days": t`Days a calendar feed reaches back`,
    "feed.future_days": t`Days a calendar feed reaches ahead`,
    "retention.staged_snapshot_seconds": t`A snapshot sent, not yet imported`,
    "retention.queued_snapshot_seconds": t`A snapshot waiting for its job`,
    "usage.active_days": t`Days an account counts as active`,
    "usage.trend_days": t`Days of usage Health shows`,
    "auth.acting_reason_chars": t`The reason for acting as someone`,
    "import.field_name_chars": t`A field's name an import makes`,
    "request.link_calls": t`Calls of public links in one request`,
    "copy.id_chars": t`A record's key in a store read by copy`,
    "automation.script_time_ms": t`A script's time`,
    "automation.script_run_ms": t`The scripts of one run together`,
    "automation.script_memory_bytes": t`A script's memory`,
    "automation.script_calls": t`Reads and writes a script asks`,
    "automation.script_call_bytes": t`What one call of a script carries`,
    "automation.script_reply_bytes": t`What the instance answers a script's call`,
    "automation.script_output_bytes": t`What a script hands to the actions after it`,
    "automation.script_heap_mb": t`The memory of a script's process`,
    "automation.script_start_ms": t`A script's process starting`,
    "automation.script_grace_ms": t`A script past its time, before it is ended`,
    "import.parse_heap_mb": t`The memory of a file's reading`,
    "import.scan_ms": t`A file read through`,
    "import.batch_ms": t`A batch of a file's rows`,
    "import.zip_entries": t`Parts of a spreadsheet's archive`,
    "import.zip_entry_bytes": t`A part of a spreadsheet's archive`,
    "import.zip_total_bytes": t`A spreadsheet's archive, unpacked`,
  };
}

function useFamilyNames(): Record<
  LimitFamily,
  { title: string; description: string }
> {
  const { t } = useLingui();
  return {
    rate: {
      title: t`Requests a minute, per address`,
      description: t`Each address may send this many requests of a kind a minute, counted across every process of the instance; one more is refused until the minute ends. Raise one when many people share an address (an office behind one proxy), within its bounds.`,
    },
    work: {
      title: t`Work in the background and live connections`,
      description: t`Set here, each within its bounds; the pages one connection follows, by AnyGridDB.`,
    },
    files: {
      title: t`Imports, exports, copies and files`,
      description: t`The rows one file brings in, and one export writes out, are set here unless the instance's environment fixes them; the largest file in a cell, in Settings.`,
    },
    reads: {
      title: t`What a page reads and shows`,
      description: t`A screen that holds back says what it left out.`,
    },
    kept: {
      title: t`How long things are kept`,
      description: t`The trash and restore points are set in Settings, the sign-in trail in Security; the change trail, kept for ever unless Security says otherwise, is not listed.`,
    },
    access: {
      title: t`Signing in, codes and links`,
      description: t`Set by AnyGridDB. How long a link, a code or a challenge lasts is the exchange's own and never changes.`,
    },
    content: {
      title: t`What a cell, a formula and a view hold`,
      description: t`Set by AnyGridDB.`,
    },
    outside: {
      title: t`Channels, directories and calls out`,
      description: t`Set by AnyGridDB: how much a channel, a directory or a store sends or answers, and how long a call out may take.`,
    },
    automations: {
      title: t`An automation's shape`,
      description: t`Set by AnyGridDB.`,
    },
  };
}

function useUnitNames(): Record<LimitUnit, string> {
  const { t } = useLingui();
  return {
    "requests per minute": t`requests a minute`,
    "runs per minute": t`runs a minute`,
    minutes: t`minutes`,
    hours: t`hours`,
    days: t`days`,
    rows: t`rows`,
    bytes: t`bytes`,
    jobs: t`jobs`,
    sockets: t`connections`,
    channels: t`pages`,
    groups: t`groups`,
    actions: t`actions`,
    characters: t`characters`,
    secrets: t`secrets`,
    milliseconds: t`milliseconds`,
    seconds: t`seconds`,
    attempts: t`tries`,
    items: t`items`,
    levels: t`levels`,
    accounts: t`accounts`,
    bases: t`bases`,
    mebibytes: t`MiB`,
  };
}

function useScopeNames(): Record<LimitScope, string> {
  const { t } = useLingui();
  return {
    instance: t`The instance`,
    account: t`An account`,
    address: t`An address`,
    automation: t`An automation`,
    socket: t`A connection`,
    request: t`A request`,
    view: t`A view`,
    channel: t`A channel`,
    session: t`A sign-in`,
    link: t`A link`,
    file: t`A file`,
    cell: t`A cell`,
  };
}

function useSetByNames(): Record<LimitSetBy, string> {
  const { t } = useLingui();
  return {
    code: t`AnyGridDB`,
    environment: t`The environment`,
    security: t`Security`,
    settings: t`Settings`,
    limits: t`This page`,
    protocol: t`The exchange itself`,
  };
}

/**
 * Administration's "Limits and usage" (ADR 0132): every limit the instance
 * keeps, where it is set, and what is used of it where it is counted. The
 * requests a minute and the rows of a file are set here, within their
 * bounds, unless the environment fixes them. Counts only: no
 * address and no account is shown.
 */
export function LimitsTab() {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const formatBytes = useFormatBytes();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const limits = useQuery({
    ...api.admin.limits.queryOptions(),
    refetchInterval: 30_000,
  });
  const settings = useQuery(api.admin.settings.queryOptions());
  const [draft, setDraft] = useState<LimitDraft>({});
  const [invalid, setInvalid] = useState<readonly SettableLimitId[]>([]);
  const [saving, setSaving] = useState(false);
  const names = useLimitNames();
  const families = useFamilyNames();
  const units = useUnitNames();
  const scopes = useScopeNames();
  const setBy = useSetByNames();
  const failed = limits.error ?? settings.error;
  if (failed) {
    return (
      <LoadFailed
        error={failed}
        onRetry={() => {
          void limits.refetch();
          void settings.refetch();
        }}
      />
    );
  }
  if (!limits.data || !settings.data) return <Spinner />;
  const set = settings.data.limits;
  const number = new Intl.NumberFormat(intlLocale(i18n.locale));
  const amount = (row: LimitRow, value: number) =>
    row.unit === "bytes"
      ? formatBytes(value)
      : `${number.format(value)} ${units[row.unit]}`;
  const changed = (family: LimitFamily) =>
    Object.keys(splitDraft(draft, family)[0]).length > 0;
  // Each part of the page saves its own fields; what was set elsewhere is
  // sent as it was saved.
  async function save(family: LimitFamily) {
    const outcome = limitsFromDraft(splitDraft(draft, family)[0], set);
    if ("invalid" in outcome) {
      setInvalid(outcome.invalid);
      return;
    }
    setInvalid([]);
    setSaving(true);
    const failure = await sendLimits(outcome.limits, stepUp.ensure);
    setSaving(false);
    if (failure === "declined") return;
    if (failure !== null) {
      toast.error(errorText(failure.cause));
      return;
    }
    await Promise.all(
      [api.admin.settings, api.admin.limits].map((procedure) =>
        queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
      ),
    );
    setDraft((typed) => splitDraft(typed, family)[1]);
    toast.success(t`Limits saved`);
  }
  const rows = (family: LimitFamily) =>
    limits.data.filter((row) => FAMILY_OF[row.id] === family);
  // Set on this page: the environment does not fix it (ADR 0083).
  const settable = (row: LimitRow) =>
    row.setBy === "limits" && row.bounds !== undefined;
  const hint = (row: LimitRow) => {
    const [floor, top] = row.bounds ?? [row.value, row.value];
    return (
      <p
        id={`limit-${row.id}-hint`}
        className={
          invalid.includes(row.id as SettableLimitId)
            ? "text-xs font-normal text-danger"
            : "text-xs font-normal text-muted-foreground"
        }
      >
        {t`From ${{ floor: number.format(floor) }} to ${{ top: number.format(top) }}; shipped with ${{ shipped: number.format(row.value) }}.`}
      </p>
    );
  };
  const field = (row: LimitRow) => {
    const id = row.id as SettableLimitId;
    return (
      <Input
        inputMode="numeric"
        className="w-32"
        aria-label={names[row.id]}
        aria-describedby={`limit-${row.id}-hint`}
        aria-invalid={invalid.includes(id) || undefined}
        value={draft[id] ?? String(row.now)}
        onChange={(event) => setDraft({ ...draft, [id]: event.target.value })}
      />
    );
  };
  const actions = (family: LimitFamily) => (
    <>
      {rows(family).some((row) =>
        invalid.includes(row.id as SettableLimitId),
      ) ? (
        <p role="alert" className="text-sm text-danger">
          {t`Each limit takes a whole number within its bounds.`}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          onClick={() => void save(family)}
          disabled={!changed(family) || saving}
        >
          {t`Save`}
        </Button>
        <Button
          variant="ghost"
          disabled={!changed(family) || saving}
          onClick={() => {
            setDraft(splitDraft(draft, family)[1]);
            setInvalid([]);
          }}
        >
          {t`Cancel`}
        </Button>
      </div>
    </>
  );
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {stepUp.dialog}
      <p className="text-sm text-muted-foreground">
        {t`Every limit the instance keeps to, where it is set, and what is used of it where the instance counts it. What is used is a count: it names no address and no account.`}
      </p>
      {LIMIT_FAMILIES.map((family) =>
        family === "rate" ? (
          <RuledSection
            key={family}
            title={families.rate.title}
            description={families.rate.description}
          >
            <AdminTable
              role="region"
              aria-label={families.rate.title}
              tabIndex={0}
              className="focus-visible:outline-2 focus-visible:outline-ring"
            >
              <AdminTableHead>
                <tr>
                  <th className="px-3 py-2 text-left">{t`Requests`}</th>
                  <th className="px-3 py-2 text-left">{t`A minute`}</th>
                  <th className="px-3 py-2 text-right">
                    {t`Most from one address`}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {t`Addresses refused`}
                  </th>
                </tr>
              </AdminTableHead>
              <tbody>
                {rows(family).map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <th scope="row" className="px-3 py-2 text-left">
                      <span className="font-medium">{names[row.id]}</span>
                      {hint(row)}
                    </th>
                    <td className="px-3 py-2">{field(row)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {number.format(row.used?.most ?? 0)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {number.format(row.used?.past ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
            <p className="text-xs text-muted-foreground">
              {t`What is used is counted over this minute and the one before.`}
            </p>
            {actions(family)}
          </RuledSection>
        ) : (
          <RuledSection
            key={family}
            title={families[family].title}
            description={families[family].description}
          >
            <AdminTable
              role="region"
              aria-label={families[family].title}
              tabIndex={0}
              className="focus-visible:outline-2 focus-visible:outline-ring"
            >
              <AdminTableHead>
                <tr>
                  <th className="px-3 py-2 text-left">{t`Limit`}</th>
                  <th className="px-3 py-2 text-left">{t`Value`}</th>
                  <th className="px-3 py-2 text-left">{t`Counted for`}</th>
                  <th className="px-3 py-2 text-left">{t`Set by`}</th>
                </tr>
              </AdminTableHead>
              <tbody>
                {rows(family).map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <th scope="row" className="px-3 py-2 text-left">
                      <span className="font-medium">{names[row.id]}</span>
                      {row.used ? (
                        <p className="text-xs text-muted-foreground">
                          {t`Now: at most ${{ most: number.format(row.used.most) }} for one account; ${{ past: number.format(row.used.past) }} at the limit.`}
                        </p>
                      ) : null}
                      {settable(row) ? hint(row) : null}
                    </th>
                    <td className="px-3 py-2 tabular-nums">
                      {settable(row) ? field(row) : amount(row, row.now)}
                    </td>
                    <td className="px-3 py-2">{scopes[row.scope]}</td>
                    <td className="px-3 py-2">{setBy[row.setBy]}</td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
            {rows(family).some(settable) ? actions(family) : null}
          </RuledSection>
        ),
      )}
    </div>
  );
}
