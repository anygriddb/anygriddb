import type { InstanceSettingsPatch } from "@anygriddb/core";
import { Label, Select, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";

function Section(props: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-sm border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">{props.title}</h2>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

/**
 * A choice among values, with the current one kept when it is not among
 * them (set through the API, say).
 */
function Choice<T extends string | number>(props: {
  id: string;
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
  hint?: string;
}) {
  const options = props.options.some(([value]) => value === props.value)
    ? props.options
    : [...props.options, [props.value, String(props.value)] as const];
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Select
        id={props.id}
        className="max-w-md"
        value={String(props.value)}
        onChange={(event) => {
          const picked = options.find(
            ([value]) => String(value) === event.target.value,
          );
          if (picked) props.onChange(picked[0]);
        }}
      >
        {options.map(([value, label]) => (
          <option key={String(value)} value={String(value)}>
            {label}
          </option>
        ))}
      </Select>
      {props.hint ? (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      ) : null}
    </div>
  );
}

/**
 * The instance's security policy (ADR 0043): simple defaults an
 * administrator may change, never past the floors the API keeps.
 */
export function SecurityTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(api.admin.settings.queryOptions());
  async function save(patch: InstanceSettingsPatch) {
    try {
      await trpc.admin.updateSettings.mutate(patch);
      await Promise.all(
        [api.admin.settings, api.auth.instance, api.session.current].map(
          (procedure) =>
            queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
        ),
      );
      toast.success(t`Settings saved`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  const data = settings.data;
  if (!data) return <Spinner />;
  const minutes = (value: number) =>
    value < 60
      ? t`${{ value }} minutes`
      : value === 60
        ? t`1 hour`
        : value % 60 === 0
          ? t`${{ value: value / 60 }} hours`
          : t`${{ value }} minutes`;
  const hours = (value: number) =>
    value === 1
      ? t`1 hour`
      : value === 24
        ? t`1 day`
        : value % 24 === 0
          ? t`${{ value: value / 24 }} days`
          : t`${{ value }} hours`;
  const days = (value: number) => t`${{ value }} days`;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t`Each choice starts at a value that suits most organizations. Change it to follow your own rules: the limits that protect accounts cannot be turned off.`}
      </p>

      <Section
        title={t`Second factor`}
        description={t`Administrators always need one; base owners include anyone creating a base. A person without one is asked to set it up before going on.`}
      >
        <Choice
          id="policy-mfa-scope"
          label={t`Who needs a second factor`}
          value={data.mfaScope}
          options={[
            ["admins", t`Administrators only`],
            ["owners", t`Administrators and base owners`],
            ["everyone", t`Everyone`],
          ]}
          onChange={(mfaScope) => void save({ mfaScope })}
        />
        {data.ssoReady ? (
          <Choice
            id="policy-sso-mfa"
            label={t`After single sign-on`}
            value={data.ssoMfa}
            options={[
              ["local", t`Ask for AnyGridDB's own second factor too`],
              ["provider", t`Trust the identity provider's second factor`],
            ]}
            onChange={(ssoMfa) => void save({ ssoMfa })}
            hint={t`Trust it only if your identity provider requires a second factor of everyone. An account that signs in only through it then needs none here.`}
          />
        ) : null}
      </Section>

      <Section
        title={t`Failed sign-ins`}
        description={t`Wrong passwords and wrong second-factor codes count, per account, whatever the address they come from. A success starts the count over. The person is told by email.`}
      >
        <Choice
          id="policy-lockout-threshold"
          label={t`Lock an account after`}
          value={data.lockoutThreshold}
          options={[3, 5, 10, 15, 20].map(
            (value) =>
              [value, t`${{ value }} failed attempts in a row`] as const,
          )}
          onChange={(lockoutThreshold) => void save({ lockoutThreshold })}
        />
        <Choice
          id="policy-lockout-minutes"
          label={t`For`}
          value={data.lockoutMinutes}
          options={[
            ...[5, 15, 30, 60, 240, 1440].map(
              (value) => [value, minutes(value)] as const,
            ),
            [0, t`Until an administrator unlocks it`] as const,
          ]}
          onChange={(lockoutMinutes) => void save({ lockoutMinutes })}
          hint={t`Locking until an administrator acts lets anyone who knows an address lock its account. An administrator is never locked for more than an hour.`}
        />
        <Choice
          id="policy-lock-alerts"
          label={t`Tell administrators`}
          value={data.lockAlerts ? "on" : "off"}
          options={[
            ["on", t`Yes, in the app and by email`],
            ["off", t`No`],
          ]}
          onChange={(value) => void save({ lockAlerts: value === "on" })}
          hint={t`Past ten locks within an hour, one last alert says so; the sign-in trail keeps them all.`}
        />
      </Section>

      <Section
        title={t`Accounts and access`}
        description={t`Who may create what, whom owners may invite, and what happens to accounts nobody uses.`}
      >
        <Choice
          id="policy-base-creation"
          label={t`Who can create bases`}
          value={data.baseCreation}
          options={[
            ["everyone", t`Everyone`],
            ["admins", t`Only administrators`],
          ]}
          onChange={(baseCreation) => void save({ baseCreation })}
          hint={t`Bases already made stay with their owners.`}
        />
        <Choice
          id="policy-api-tokens"
          label={t`Who can create API tokens`}
          value={data.apiTokens}
          options={[
            ["everyone", t`Everyone`],
            ["admins", t`Only administrators`],
          ]}
          onChange={(apiTokens) => void save({ apiTokens })}
          hint={t`While only administrators may, the tokens others made stop working, and work again if you change your mind.`}
        />
        <Choice
          id="policy-invitations"
          label={t`Whom owners can invite`}
          value={data.invitations}
          options={[
            ["anyone", t`Any address`],
            ["domains", t`Only addresses of the sign-up domains`],
          ]}
          onChange={(invitations) => void save({ invitations })}
          hint={
            data.signupDomains.length === 0
              ? t`No sign-up domains are set (Settings tab): until some are, any address can be invited.`
              : t`Domains: ${{ domains: data.signupDomains.join(", ") }}. Invitations already sent to other addresses stop working, and so does adding such an account to a base.`
          }
        />
        <Choice
          id="policy-inactive-days"
          label={t`Disable accounts nobody uses`}
          value={data.inactiveDays}
          options={[
            [0, t`Never`],
            ...[30, 60, 90, 180, 365].map(
              (value) =>
                [value, t`After ${{ value }} days without activity`] as const,
            ),
          ]}
          onChange={(inactiveDays) => void save({ inactiveDays })}
          hint={
            data.smtpReady
              ? t`A sign-in or a token in use counts as activity. The person is warned by email a week before. Administrators and accounts kept by an identity provider (SCIM) are never disabled; an administrator can enable an account again.`
              : t`A sign-in or a token in use counts as activity. Email is not set up: accounts are disabled without warning. Administrators and accounts kept by an identity provider (SCIM) are never disabled; an administrator can enable an account again.`
          }
        />
      </Section>

      <Section
        title={t`Sessions`}
        description={t`A session ends after a while without activity, and at its lifetime in any case. A shorter choice applies to sessions already open.`}
      >
        <Choice
          id="policy-session-idle"
          label={t`End a session after this long without activity`}
          value={data.sessionIdleMinutes}
          options={[5, 15, 30, 60, 120, 240, 480].map(
            (value) => [value, minutes(value)] as const,
          )}
          onChange={(sessionIdleMinutes) => void save({ sessionIdleMinutes })}
        />
        <Choice
          id="policy-session-max"
          label={t`End it in any case after`}
          value={data.sessionMaxHours}
          options={[1, 4, 8, 12, 24, 72, 168].map(
            (value) => [value, hours(value)] as const,
          )}
          onChange={(sessionMaxHours) => void save({ sessionMaxHours })}
        />
      </Section>

      <Section
        title={t`Passwords`}
        description={t`A longer password is the strongest rule: AnyGridDB asks for no mix of characters, and never for a change on a schedule.`}
      >
        <Choice
          id="policy-password-length"
          label={t`Minimum length`}
          value={data.passwordMinLength}
          options={[12, 14, 16, 20, 24].map(
            (value) => [value, t`${{ value }} characters`] as const,
          )}
          onChange={(passwordMinLength) => void save({ passwordMinLength })}
          hint={t`New and changed passwords follow it; existing ones keep working.`}
        />
        <Choice
          id="policy-password-reset"
          label={t`Who can start a password reset`}
          value={data.passwordReset}
          options={[
            ["self", t`The person, with a link sent by email`],
            ["admin", t`Only an administrator`],
          ]}
          onChange={(passwordReset) => void save({ passwordReset })}
          hint={
            data.smtpReady
              ? t`A link works once: an hour when the person asks, a day when an administrator sends it. Second factors stay in place.`
              : t`Email is not set up: only an administrator can send a link, which they pass on themselves.`
          }
        />
      </Section>

      <Section
        title={t`API tokens and public links`}
        description={t`What people may open to scripts and to anyone with a link.`}
      >
        <Choice
          id="policy-token-days"
          label={t`An API token lives at most`}
          value={data.tokenMaxDays}
          options={[7, 30, 90, 180, 365].map(
            (value) => [value, days(value)] as const,
          )}
          onChange={(tokenMaxDays) => void save({ tokenMaxDays })}
          hint={t`A shorter choice also ends the tokens already made that are older.`}
        />
        <Choice
          id="policy-public-links"
          label={t`Public links to views and forms`}
          value={data.publicLinks}
          options={[
            ["allowed", t`Allowed`],
            ["password", t`Only with a password`],
            ["off", t`Off`],
          ]}
          onChange={(publicLinks) => void save({ publicLinks })}
          hint={t`Links that no longer fit stop opening at once, and open again if you change your mind.`}
        />
      </Section>

      <Section
        title={t`Sign-in trail`}
        description={t`Sign-ins, failures, and what administrators changed, with the address. The CNIL recommends keeping such logs six months to a year.`}
      >
        <Choice
          id="policy-auth-retention"
          label={t`Keep events for`}
          value={data.authRetentionDays}
          options={[
            [180, t`6 months`],
            [270, t`9 months`],
            [365, t`1 year`],
          ]}
          onChange={(authRetentionDays) => void save({ authRetentionDays })}
        />
      </Section>
    </div>
  );
}
