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
      description: t`Set by AnyGridDB.`,
    },
    files: {
      title: t`Imports, exports, copies and files`,
      description: t`The rows imported or exported at once are set by the instance's environment; the largest file in a cell, in Settings.`,
    },
    reads: {
      title: t`What a page reads and shows`,
      description: t`A screen that holds back says what it left out.`,
    },
    kept: {
      title: t`How long things are kept`,
      description: t`The trash and restore points are set in Settings, the sign-in trail in Security; the change trail, kept for ever unless Security says otherwise, is not listed.`,
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
  };
}

/**
 * Administration's "Limits and usage" (ADR 0132): every limit the instance
 * keeps, where it is set, and what is used of it where it is counted. The
 * requests a minute are set here, within their bounds. Counts only: no
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
  const changed = Object.keys(draft).length > 0;
  async function save() {
    const outcome = limitsFromDraft(draft, set);
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
    setDraft({});
    toast.success(t`Limits saved`);
  }
  const rows = (family: LimitFamily) =>
    limits.data.filter((row) => FAMILY_OF[row.id] === family);
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
                {rows(family).map((row) => {
                  const id = row.id as SettableLimitId;
                  const [floor, top] = row.bounds ?? [row.value, row.value];
                  const hintId = `limit-${row.id}-hint`;
                  const wrong = invalid.includes(id);
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <th scope="row" className="px-3 py-2 text-left">
                        <span className="font-medium">{names[row.id]}</span>
                        <p
                          id={hintId}
                          className={
                            wrong
                              ? "text-xs text-danger"
                              : "text-xs text-muted-foreground"
                          }
                        >
                          {t`From ${{ floor: number.format(floor) }} to ${{ top: number.format(top) }}; shipped with ${{ shipped: number.format(row.value) }}.`}
                        </p>
                      </th>
                      <td className="px-3 py-2">
                        <Input
                          inputMode="numeric"
                          className="w-28"
                          aria-label={names[row.id]}
                          aria-describedby={hintId}
                          aria-invalid={wrong || undefined}
                          value={draft[id] ?? String(row.now)}
                          onChange={(event) =>
                            setDraft({ ...draft, [id]: event.target.value })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {number.format(row.used?.most ?? 0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {number.format(row.used?.past ?? 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </AdminTable>
            <p className="text-xs text-muted-foreground">
              {t`What is used is counted over this minute and the one before.`}
            </p>
            {invalid.length > 0 ? (
              <p role="alert" className="text-sm text-danger">
                {t`Each limit takes a whole number within its bounds.`}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button onClick={() => void save()} disabled={!changed || saving}>
                {t`Save`}
              </Button>
              <Button
                variant="ghost"
                disabled={!changed || saving}
                onClick={() => {
                  setDraft({});
                  setInvalid([]);
                }}
              >
                {t`Cancel`}
              </Button>
            </div>
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
                    </th>
                    <td className="px-3 py-2 tabular-nums">
                      {amount(row, row.now)}
                    </td>
                    <td className="px-3 py-2">{scopes[row.scope]}</td>
                    <td className="px-3 py-2">{setBy[row.setBy]}</td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </RuledSection>
        ),
      )}
    </div>
  );
}
